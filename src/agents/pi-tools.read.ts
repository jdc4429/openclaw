import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import {
  appendFileWithinRoot,
  SafeOpenError,
  openFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
import { trySafeFileURLToPath } from "../infra/local-file-access.js";
import { detectMime } from "../media/mime.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { sanitizeToolResultMedia } from "./tool-media.js";
import { type TextContentBlock } from "./tool-images.js";

export {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";

const normalizeToolParams = (params: unknown): Record<string, unknown> | undefined => {
  if (!params) return undefined;
  if (typeof params === "object") return params as Record<string, unknown>;
  return undefined;
};

const CLAUDE_PARAM_GROUPS = {
  read: [{ keys: ["path"] }] as const,
  write: [{ keys: ["path", "content"] }] as const,
  edit: [{ keys: ["file_path", "old_string", "new_string"] }] as const,
};

type ToolContentBlock = AgentToolResult<unknown>["content"][number];

const DEFAULT_READ_PAGE_MAX_BYTES = 512 * 1024;
const MAX_ADAPTIVE_READ_MAX_BYTES = 512 * 1024;
const ADAPTIVE_READ_CONTEXT_SHARE = 0.2;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_ADAPTIVE_READ_PAGES = 8;

type OpenClawReadToolOptions = {
  modelContextWindowTokens?: number;
  imageSanitization?: ImageSanitizationLimits;
  root?: string;
  containerWorkdir?: string;
};

type ReadTruncationDetails = {
  truncated: boolean;
  outputLines: number;
  firstLineExceedsLimit: boolean;
};

const READ_CONTINUATION_NOTICE_RE =
  /\n\n\[(?:Showing lines [^\]]*?Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]\s*$/;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveAdaptiveReadMaxBytes(options?: OpenClawReadToolOptions): number {
  const contextWindowTokens = options?.modelContextWindowTokens;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return DEFAULT_READ_PAGE_MAX_BYTES;
  }
  const fromContext = Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * ADAPTIVE_READ_CONTEXT_SHARE,
  );
  return clamp(fromContext, DEFAULT_READ_PAGE_MAX_BYTES, MAX_ADAPTIVE_READ_MAX_BYTES);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function getToolResultText(result: AgentToolResult<unknown>): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlocks = content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return undefined;
    })
    .filter((value): value is string => typeof value === "string");
  if (textBlocks.length === 0) return undefined;
  return textBlocks.join("\n");
}

function withToolResultText(
  result: AgentToolResult<unknown>,
  text: string,
): AgentToolResult<unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  let replaced = false;
  const nextContent: ToolContentBlock[] = content.map((block) => {
    if (
      !replaced &&
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      replaced = true;
      return { ...(block as TextContentBlock), text };
    }
    return block;
  });
  if (replaced) {
    return {
      ...result,
      content: nextContent as unknown as AgentToolResult<unknown>["content"],
    };
  }
  const textBlock = { type: "text", text } as unknown as TextContentBlock;
  return {
    ...result,
    content: [textBlock] as unknown as AgentToolResult<unknown>["content"],
  };
}

function extractReadTruncationDetails(
  result: AgentToolResult<unknown>,
): ReadTruncationDetails | null {
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const truncation = (details as { truncation?: unknown }).truncation;
  if (!truncation || typeof truncation !== "object") return null;
  const record = truncation as Record<string, unknown>;
  if (record.truncated !== true) return null;
  const outputLinesRaw = record.outputLines;
  const outputLines =
    typeof outputLinesRaw === "number" && Number.isFinite(outputLinesRaw)
      ? Math.max(0, Math.floor(outputLinesRaw))
      : 0;
  return {
    truncated: true,
    outputLines,
    firstLineExceedsLimit: record.firstLineExceedsLimit === true,
  };
}

function stripReadContinuationNotice(text: string): string {
  return text.replace(READ_CONTINUATION_NOTICE_RE, "");
}

function stripReadTruncationContentDetails(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return result;
  const detailsRecord = details as Record<string, unknown>;
  const truncationRaw = detailsRecord.truncation;
  if (!truncationRaw || typeof truncationRaw !== "object") return result;
  const truncation = truncationRaw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(truncation, "content")) return result;
  const { content: _content, ...restTruncation } = truncation;
  return {
    ...result,
    details: { ...detailsRecord, truncation: restTruncation } as any,
  };
}

async function executeReadWithAdaptivePaging(params: {
  base: AnyAgentTool;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  maxBytes: number;
}): Promise<AgentToolResult<unknown>> {
  const userLimit = params.args.limit;
  const hasExplicitLimit =
    typeof userLimit === "number" && Number.isFinite(userLimit) && userLimit > 0;
  if (hasExplicitLimit) {
    return params.base.execute(params.toolCallId, params.args, params.signal);
  }

  const offsetRaw = params.args.offset;
  let nextOffset =
    typeof offsetRaw === "number" && Number.isFinite(offsetRaw) && offsetRaw > 0
      ? Math.floor(offsetRaw)
      : 1;
  let firstResult: AgentToolResult<unknown> | null = null;
  let aggregatedText = "";
  let aggregatedBytes = 0;
  let capped = false;
  let continuationOffset: number | undefined;

  for (let page = 0; page < MAX_ADAPTIVE_READ_PAGES; page += 1) {
    const pageArgs = { ...params.args, offset: nextOffset };
    const pageResult = await params.base.execute(params.toolCallId, pageArgs, params.signal);
    firstResult ??= pageResult;

    const content = Array.isArray(pageResult.content) ? pageResult.content : [];
    const hasMediaBlock = content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { type?: unknown }).type === "string" &&
        ["image", "audio", "video"].includes((block as { type: string }).type),
    );

    if (hasMediaBlock) return pageResult;

    const rawText = getToolResultText(pageResult);
    if (typeof rawText !== "string") return pageResult;

    const truncation = extractReadTruncationDetails(pageResult);
    const canContinue =
      Boolean(truncation?.truncated) &&
      !truncation?.firstLineExceedsLimit &&
      (truncation?.outputLines ?? 0) > 0 &&
      page < MAX_ADAPTIVE_READ_PAGES - 1;
    const pageText = canContinue ? stripReadContinuationNotice(rawText) : rawText;
    const delimiter = aggregatedText ? "\n\n" : "";
    const nextBytes = Buffer.byteLength(`${delimiter}${pageText}`, "utf-8");

    if (aggregatedText && aggregatedBytes + nextBytes > params.maxBytes) {
      capped = true;
      continuationOffset = nextOffset;
      break;
    }

    aggregatedText += `${delimiter}${pageText}`;
    aggregatedBytes += nextBytes;

    if (!canContinue || !truncation) {
      return withToolResultText(pageResult, aggregatedText);
    }

    nextOffset += truncation.outputLines;
    continuationOffset = nextOffset;

    if (aggregatedBytes >= params.maxBytes) {
      capped = true;
      break;
    }
  }

  if (!firstResult) {
    return params.base.execute(params.toolCallId, params.args, params.signal);
  }

  let finalText = aggregatedText;
  if (capped && continuationOffset) {
    finalText += `\n\n[Read output capped at ${formatBytes(params.maxBytes)} for this call. Use offset=${continuationOffset} to continue.]`;
  }
  return withToolResultText(firstResult, finalText);
}

function mapContainerPathToWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
}): string {
  const containerWorkdir = params.containerWorkdir?.trim();
  if (!containerWorkdir) return params.filePath;
  const normalizedWorkdir = containerWorkdir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedWorkdir.startsWith("/")) return params.filePath;

  let candidate = params.filePath.startsWith("@") ? params.filePath.slice(1) : params.filePath;
  if (/^file:\/\//i.test(candidate)) {
    const localFilePath = trySafeFileURLToPath(candidate);
    if (!localFilePath) return params.filePath;
    candidate = localFilePath;
  }

  const normalizedCandidate = candidate.replace(/\\/g, "/");
  if (normalizedCandidate === normalizedWorkdir) return path.resolve(params.root);
  const prefix = `${normalizedWorkdir}/`;
  if (!normalizedCandidate.startsWith(prefix)) return candidate;
  const relative = normalizedCandidate.slice(prefix.length);
  if (!relative) return path.resolve(params.root);
  return path.resolve(params.root, ...relative.split("/").filter(Boolean));
}

export function resolveToolPathAgainstWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
}): string {
  const mapped = mapContainerPathToWorkspaceRoot(params);
  const candidate = mapped.startsWith("@") ? mapped.slice(1) : mapped;
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(params.root, candidate || ".");
}

export function wrapToolWorkspaceRootGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return wrapToolWorkspaceRootGuardWithOptions(tool, root);
}

export function wrapToolWorkspaceRootGuardWithOptions(
  tool: AnyAgentTool,
  root: string,
  options?: { containerWorkdir?: string },
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record = getToolParamsRecord(args);
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        const sandboxPath = mapContainerPathToWorkspaceRoot({
          filePath,
          root,
          containerWorkdir: options?.containerWorkdir,
        });
        await assertSandboxPath({ filePath: sandboxPath, cwd: root, root });
      }
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

export function wrapToolMemoryFlushAppendOnlyWrite(
  tool: AnyAgentTool,
  options: { root: string; relativePath: string; containerWorkdir?: string; sandbox?: any },
): AnyAgentTool {
  const allowedAbsolutePath = path.resolve(options.root, options.relativePath);
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record = getToolParamsRecord(args);
      const filePath = typeof record?.path === "string" ? record.path : undefined;
      const content = typeof record?.content === "string" ? record.content : undefined;
      if (filePath && content !== undefined) {
        const resolvedPath = resolveToolPathAgainstWorkspaceRoot({
          filePath,
          root: options.root,
          containerWorkdir: options.containerWorkdir,
        });
        if (resolvedPath !== allowedAbsolutePath) {
          throw new Error(`Memory flush restricted to ${options.relativePath}`);
        }
        await appendFileWithinRoot({
          rootDir: options.root,
          relativePath: options.relativePath,
          data: content,
          mkdir: true,
          prependNewlineIfNeeded: true,
        });
        return {
          toolCallId,
          content: [{ type: "text", text: `Appended to ${options.relativePath}.` }],
          details: {} as any,
        };
      }
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "avi", "mov", "mkv", "m4v"]);

function getImageMimeType(ext: string): string {
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg") return "image/jpeg";
  return `image/${ext}`;
}

export function createOpenClawReadTool(
  base: AnyAgentTool,
  options?: OpenClawReadToolOptions,
): AnyAgentTool {
  return {
    ...base,
    execute: async (toolCallId, params, signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);

      let rawPath = typeof record?.path === "string" ? record.path : ".";
      rawPath = rawPath.replace(/[^\x00-\x7F]/g, "");

      const rootDir = options?.root ? path.resolve(options.root) : process.cwd();
      let cleanPath = rawPath;
      const rootBaseName = path.basename(rootDir);
      if (cleanPath.startsWith(`${rootBaseName}/`)) {
        cleanPath = cleanPath.substring(rootBaseName.length + 1);
      }
      const inputPath = path.isAbsolute(cleanPath)
        ? cleanPath
        : path.resolve(rootDir, cleanPath);

      try {
        const stats = await fs.stat(inputPath);

        if (stats.isDirectory()) {
          const files = await fs.readdir(inputPath);
          return {
            toolCallId,
            content: [{ type: "text", text: `Listing for ${cleanPath}:\n${files.join("\n")}` }],
            details: { path: inputPath } as any,
          };
        }

        const ext = inputPath.toLowerCase().split(".").pop() ?? "";
        const fileName = path.basename(inputPath);
        const mediaUrl = `http://localhost:18791${inputPath}`;

        if (IMAGE_EXTENSIONS.has(ext)) {
          const fileBuffer = await fs.readFile(inputPath);
          const mimeType = getImageMimeType(ext);

          return {
            toolCallId,
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: fileBuffer.toString("base64"),
                },
              },
              {
                type: "text",
                text: `📷 [${fileName}](${mediaUrl})`,
              },
            ],
            details: { path: inputPath, size: stats.size } as any,
          } as any;
        }

        if (AUDIO_EXTENSIONS.has(ext)) {
          return {
            toolCallId,
            content: [
              {
                type: "text",
                text: `🎵 [${fileName}](${mediaUrl})`,
              },
            ],
            details: { path: inputPath, size: stats.size } as any,
          } as any;
        }

        if (VIDEO_EXTENSIONS.has(ext)) {
          return {
            toolCallId,
            content: [
              {
                type: "text",
                text: `🎬 [${fileName}](${mediaUrl})`,
              },
            ],
            details: { path: inputPath, size: stats.size } as any,
          } as any;
        }

        const result = await executeReadWithAdaptivePaging({
          base,
          toolCallId,
          args: { ...record, path: inputPath },
          signal,
          maxBytes: resolveAdaptiveReadMaxBytes(options),
        });

        return stripReadTruncationContentDetails(result);
      } catch (err) {
        const error = err as Error;
        return {
          toolCallId,
          content: [{ type: "text", text: `Read failed: ${error.message}` }],
          details: { isError: true, path: inputPath } as any,
        };
      }
    },
  };
}

export function createSandboxedReadTool(params: {
  root: string;
  bridge: SandboxFsBridge;
  modelContextWindowTokens?: number;
  imageSanitization?: ImageSanitizationLimits;
}) {
  const base = createReadTool(params.root, {
    operations: {
      readFile: (absolutePath: string) =>
        params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
      access: async (absolutePath: string) => {
        const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
        if (!stat) throw new Error("ENOENT");
      },
      detectImageMimeType: async (absolutePath: string) => {
        const buffer = await params.bridge.readFile({ filePath: absolutePath, cwd: params.root });
        const mime = await detectMime({ buffer, filePath: absolutePath });
        return mime && mime.startsWith("image/") ? mime : undefined;
      },
    },
  }) as unknown as AnyAgentTool;

  return createOpenClawReadTool(base, {
    root: params.root,
    modelContextWindowTokens: params.modelContextWindowTokens,
    imageSanitization: params.imageSanitization,
  });
}

export function createSandboxedWriteTool(params: { root: string; bridge: SandboxFsBridge }) {
  const base = createWriteTool(params.root, {
    operations: {
      mkdir: async (dir: string) => {
        await params.bridge.mkdirp({ filePath: dir, cwd: params.root });
      },
      writeFile: async (absolutePath: string, content: string) => {
        await params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content });
      },
    },
  }) as unknown as AnyAgentTool;
  return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write);
}

export function createSandboxedEditTool(params: { root: string; bridge: SandboxFsBridge }) {
  const base = createEditTool(params.root, {
    operations: {
      readFile: (absolutePath: string) =>
        params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
      writeFile: (absolutePath: string, content: string) =>
        params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content }),
      access: async (absolutePath: string) => {
        const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
        if (!stat) throw new Error("ENOENT");
      },
    },
  }) as unknown as AnyAgentTool;
  return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.edit);
}

export function createHostWorkspaceWriteTool(
  root: string,
  _options?: { workspaceOnly?: boolean },
) {
  const base = createWriteTool(root, {
    operations: {
      mkdir: async (dir: string) => {
        await fs.mkdir(dir, { recursive: true });
      },
      writeFile: async (filePath: string, data: string) => {
        await fs.writeFile(filePath, data, "utf-8");
      },
    },
  }) as unknown as AnyAgentTool;
  return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write);
}

export function createHostWorkspaceEditTool(
  root: string,
  _options?: { workspaceOnly?: boolean },
) {
  const base = createEditTool(root, {
    operations: {
      readFile: async (filePath: string) => fs.readFile(filePath),
      writeFile: async (filePath: string, data: string) => {
        await fs.writeFile(filePath, data, "utf-8");
      },
      access: async (filePath: string) => {
        await fs.access(filePath);
      },
    },
  }) as unknown as AnyAgentTool;
  return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.edit);
}