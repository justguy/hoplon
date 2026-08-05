/**
 * launcher/reviewHuman.ts — human-readable renderer for the t-072 review payload.
 *
 * Mirrors the existing `renderStatusHuman` / `renderQueryHuman` pattern: the
 * machine-readable JSON envelope remains canonical; this module only
 * produces an ANSI-colored text projection of the same DTO for terminals
 * and chat surfaces that want a human-bounded approval screen.
 *
 * Coloring is conservative and driven off raw unified-diff prefixes so the
 * renderer never needs to re-compute the diff. ANSI codes are omitted when
 * `opts.color === false` so callers can still render for non-TTY sinks.
 */

import type { SessionReviewPayload } from '../contracts/reviewPayload.js';
import type { ProofVerbosity } from '../contracts/proofVerbosity.js';

export interface RenderReviewHumanOptions {
  /** When false, the renderer emits plain ASCII with no ANSI codes. */
  color?: boolean;
  proofVerbosity?: ProofVerbosity;
}

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const CYAN = '[36m';
const YELLOW = '[33m';
const MAGENTA = '[35m';

export function renderReviewHuman(
  payload: SessionReviewPayload,
  opts: RenderReviewHumanOptions = {},
): string {
  const color = opts.color ?? true;
  const proofVerbosity = opts.proofVerbosity ?? 'normal';
  const paint = (code: string) => (text: string) => (color ? `${code}${text}${RESET}` : text);
  const bold = paint(BOLD);
  const dim = paint(DIM);
  const red = paint(RED);
  const green = paint(GREEN);
  const cyan = paint(CYAN);
  const yellow = paint(YELLOW);
  const magenta = paint(MAGENTA);

  const lines: string[] = [];
  lines.push(
    `${bold('Hoplon review')} — ${cyan('session=' + payload.sessionId)} ` +
      `${dim('state=' + payload.state + ' phase=' + payload.phase)}`,
  );
  if (payload.changedFiles.length === 0) {
    lines.push(dim('  no changed files'));
  } else {
    lines.push(
      `  ${bold('changedFiles')} (${payload.changedFiles.length}): ${payload.changedFiles.join(', ')}`,
    );
  }
  if (payload.changeKindCounts !== null) {
    const c = payload.changeKindCounts;
    lines.push(
      `  ${bold('changeKindCounts')}: full_file=${c.full_file} patch=${c.patch} structural=${c.structural}`,
    );
  } else {
    lines.push(`  ${dim('changeKindCounts: (markEdited — not applicable)')}`);
  }

  for (const file of payload.files) {
    lines.push('');
    lines.push(bold(`── ${file.path} ──`));
    if (file.boundaries.length === 0 && file.fallback === null) {
      lines.push(dim('  (no textual change)'));
      continue;
    }
    if (file.fallback) {
      lines.push(
        `  ${yellow('fallback:')} ${file.fallback.reason} — ${file.fallback.message}`,
      );
      if (file.fallback.unifiedDiff.length > 0) {
        lines.push(renderDiffProjection(
          file.fallback.unifiedDiff,
          proofVerbosity,
          { red, green, cyan, dim },
        ));
      }
    }
    for (const boundary of file.boundaries) {
      const sym = boundary.symbol ?? '(anonymous)';
      const kind = boundary.symbolKind ?? 'unknown';
      const rangeLabel = `L${boundary.lineRange[0]}-${boundary.lineRange[1]}`;
      const mode = boundary.changeMode;
      const modeColor =
        mode === 'added' ? green : mode === 'removed' ? red : magenta;
      lines.push(
        `  ${modeColor('●')} ${bold(sym)} ${dim('(' + kind + ', ' + rangeLabel + ', ' + mode + ')')}`,
      );
      if (boundary.unifiedDiff.length > 0) {
        lines.push(renderDiffProjection(
          boundary.unifiedDiff,
          proofVerbosity,
          { red, green, cyan, dim },
        ));
      }
    }
  }

  lines.push('');
  lines.push(bold('Impact'));
  const di = payload.impact.dependencyImpact;
  const diLabel =
    di.status === 'AVAILABLE'
      ? green('dependency-impact')
      : di.status === 'DEGRADED'
        ? yellow('dependency-impact')
        : dim('dependency-impact');
  const diHeader = `  ${diLabel}: status=${di.status}` +
    ` subjects=${di.subjectCounts.symbol}s+${di.subjectCounts.file}f` +
    (di.warnThreshold !== null ? ` threshold=${di.warnThreshold}` : '') +
    (di.reason !== null ? ` reason=${di.reason}` : '');
  lines.push(diHeader);
  if (di.blastRadius !== null) {
    for (const e of di.blastRadius.entries) {
      const cColor =
        e.classification === 'warning'
          ? yellow
          : e.classification === 'missing_provider'
            ? dim
            : green;
      lines.push(
        `    ${cColor('•')} ${e.symbol.name} ${dim('(' + e.classification + ', refs=' + e.referenceCount + ')')}`,
      );
    }
  }
  for (const subject of di.subjects) {
    if (subject.kind === 'file') {
      lines.push(
        `    ${yellow('·')} ${subject.path} ${dim('(file-only, ' + subject.reason + ', ' + subject.origin + ')')}`,
      );
    }
  }
  if (di.detail !== null) {
    lines.push(`    ${dim('detail:')} ${di.detail}`);
  }

  const rt = payload.impact.relevantTests;
  if (rt.status === 'AVAILABLE') {
    lines.push(
      `  ${green('relevant-tests')}: confidence=${rt.result.coverageConfidence} tests=${rt.result.relevantTests.length}`,
    );
    for (const t of rt.result.relevantTests) {
      lines.push(`    • ${t}`);
    }
    if (rt.result.unusedModifiedFiles.length > 0) {
      lines.push(
        `    ${yellow('unused modified files:')} ${rt.result.unusedModifiedFiles.join(', ')}`,
      );
    }
  } else {
    lines.push(`  ${dim('relevant-tests:')} UNAVAILABLE (${rt.reason})`);
  }

  if (payload.notes.length > 0) {
    lines.push('');
    lines.push(dim(`notes: ${payload.notes.join(', ')}`));
  }

  return lines.join('\n');
}

function renderDiffProjection(
  diff: string,
  proofVerbosity: ProofVerbosity,
  colors: {
    red: (s: string) => string;
    green: (s: string) => string;
    cyan: (s: string) => string;
    dim: (s: string) => string;
  },
): string {
  if (proofVerbosity === 'compact') {
    return colors.dim(`    diff omitted from compact projection (${changedLineCount(diff)} changed lines)`);
  }
  return colorizeDiff(diff, colors);
}

function changedLineCount(diff: string): number {
  return diff
    .split('\n')
    .filter((line) =>
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---')),
    )
    .length;
}

function colorizeDiff(
  diff: string,
  colors: {
    red: (s: string) => string;
    green: (s: string) => string;
    cyan: (s: string) => string;
    dim: (s: string) => string;
  },
): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return colors.dim(line);
      }
      if (line.startsWith('@@')) {
        return colors.cyan(line);
      }
      if (line.startsWith('+')) {
        return colors.green(line);
      }
      if (line.startsWith('-')) {
        return colors.red(line);
      }
      return line;
    })
    .join('\n');
}
