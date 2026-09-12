import path from "path";

import type { PiToolMode } from "../types";
import type { VaultEditMode } from "../agent/VaultToolHost";

export type SafetyActionKind =
  | "approved-write"
  | "delete"
  | "diagnostic"
  | "prompt"
  | "read"
  | "safe-command"
  | "shell"
  | "write";

export type SafetyMode = "read-only" | "reviewed-edits";

export interface SafetyRequest {
  vaultEditMode?: VaultEditMode;
  kind: SafetyActionKind;
  command?: string;
  description?: string;
  targetPath?: string;
  /**
   * Required for `kind: "prompt"`. This is the value that decides the `--tools`
   * argument, so the policy checks it directly rather than re-parsing a command
   * string the caller assembled.
   */
  toolMode?: PiToolMode;
}

export interface SafetyDecision {
  allowed: boolean;
  reason: string;
  request: SafetyRequest;
}

export interface SafetySnapshot {
  allowedRoots: string[];
  mode: SafetyMode;
  pendingApprovals: number;
  vaultRoot?: string;
}

export function assessSafetyRequest(
  snapshot: SafetySnapshot,
  request: SafetyRequest
): SafetyDecision {
  if (request.kind === "diagnostic") {
    return {
      allowed: true,
      reason: "Diagnostic probes are always permitted.",
      request
    };
  }

  if (request.kind === "prompt") {
    if (request.toolMode === "disabled") {
      return {
        allowed: true,
        reason: "Prompt run has Pi tools disabled.",
        request
      };
    }

    if (request.toolMode === "read-only") {
      return {
        allowed: true,
        reason: request.vaultEditMode === "reviewed"
          ? "Prompt run enables Pi read tools and approval-gated vault tools."
          : "Prompt run only enables Pi read-only tools.",
        request
      };
    }

    return deny(
      request,
      "Pi prompts only allow tools disabled or the read-only tool allowlist: read, grep, find, ls."
    );
  }

  if (request.kind === "approved-write") {
    if (!request.targetPath) {
      return deny(request, "Approved writes must include a target path.");
    }

    if (!isPathInsideAnyRoot(request.targetPath, snapshot.allowedRoots)) {
      return deny(request, "Path is outside the allowed workspace roots.");
    }

    return {
      allowed: true,
      reason: "Reviewed edit mode allows approved writes inside allowed roots.",
      request
    };
  }

  if (request.kind === "safe-command") {
    if (!request.command) {
      return deny(request, "Safe commands must include a command.");
    }

    return {
      allowed: true,
      reason: "Command matched the plugin safe command allowlist.",
      request
    };
  }

  if (request.kind === "shell") {
    return deny(request, "Shell commands are blocked. Only allowlisted @cmd(...) entries run.");
  }

  if (request.kind === "write") {
    return deny(request, "Direct writes are blocked. Changes must go through a reviewed edit proposal.");
  }

  if (request.kind === "delete") {
    return deny(request, "Deletes are not supported.");
  }

  if (!request.targetPath) {
    return deny(request, "Read requests must include a target path.");
  }

  if (!isPathInsideAnyRoot(request.targetPath, snapshot.allowedRoots)) {
    return deny(request, "Path is outside the allowed workspace roots.");
  }

  return {
    allowed: true,
    reason: "Read-only request is inside an allowed workspace root.",
    request
  };
}

export function describeSafetyRequest(request: SafetyRequest): string {
  return (
    request.description ??
    request.command ??
    request.targetPath ??
    request.kind
  );
}

export function parseExternalRoots(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => path.resolve(line));
}

export function summarizeAllowedRoots(snapshot: SafetySnapshot): string {
  const externalCount = snapshot.vaultRoot
    ? Math.max(snapshot.allowedRoots.length - 1, 0)
    : snapshot.allowedRoots.length;

  if (snapshot.vaultRoot && externalCount > 0) {
    return `vault + ${externalCount} external`;
  }

  if (snapshot.vaultRoot) {
    return "vault only";
  }

  if (externalCount > 0) {
    return `${externalCount} external`;
  }

  return "none configured";
}

function deny(request: SafetyRequest, reason: string): SafetyDecision {
  return {
    allowed: false,
    reason,
    request
  };
}

export function isPathInsideAnyRoot(targetPath: string, roots: string[]): boolean {
  const resolvedTarget = path.resolve(targetPath);

  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relativePath = path.relative(resolvedRoot, resolvedTarget);

    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
  });
}
