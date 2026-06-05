export const FIX_STAGES = [
  "ai-edit",
  "ai-no-edit-retry",
  "anti-suppression",
  "typecheck",
  "build",
  "related-tests",
  "test-repair",
  "rescan",
  "regression-check",
  "regression-repair",
] as const;

export type FixStage = (typeof FIX_STAGES)[number];

export type FixProgressEvent = {
  loop: number;
  file: string;
  stage: FixStage;
  detail?: string;
};

const LABELS: Record<FixStage, string> = {
  "ai-edit": "AI edit",
  "ai-no-edit-retry": "AI retry",
  "anti-suppression": "suppression check",
  typecheck: "typecheck",
  build: "build",
  "related-tests": "related tests",
  "test-repair": "test repair",
  rescan: "rescan",
  "regression-check": "regression check",
  "regression-repair": "regression repair",
};

export function fixStageLabel(stage: FixStage): string {
  return LABELS[stage];
}
