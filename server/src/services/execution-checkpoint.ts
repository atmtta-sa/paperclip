import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const executionCheckpointSchema = z
  .object({
    version: z.literal(1),
    workspace: z
      .object({
        cwd: z.string().min(1),
        gitHead: z.string().regex(/^[a-f0-9]{40,64}$/),
        branch: z.string().min(1).nullable(),
        statusSha256: sha256,
      })
      .strict(),
    patch: z
      .object({
        kind: z.literal("git_diff"),
        sha256,
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
    tests: z
      .object({
        status: z.enum(["passed", "failed", "not_run"]),
        commands: z.array(
          z
            .object({
              command: z.string().min(1),
              exitCode: z.number().int().nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .superRefine((tests, context) => {
        const completedWithoutEvidence =
          tests.status !== "not_run" && tests.commands.length === 0;
        const notRunWithEvidence =
          tests.status === "not_run" && tests.commands.length > 0;
        const passedWithFailure =
          tests.status === "passed" &&
          tests.commands.some((command) => command.exitCode !== 0);
        const failedWithoutFailure =
          tests.status === "failed" &&
          tests.commands.length > 0 &&
          tests.commands.every((command) => command.exitCode === 0);
        if (
          completedWithoutEvidence ||
          notRunWithEvidence ||
          passedWithFailure ||
          failedWithoutFailure
        ) {
          context.addIssue({
            code: "custom",
            message: "test status must match command evidence",
            path: ["commands"],
          });
        }
      }),
    blockers: z
      .object({
        status: z.enum(["clear", "blocked"]),
        evidence: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    nextAction: z.string().min(1),
  })
  .strict();

export type ExecutionCheckpointV1 = z.infer<typeof executionCheckpointSchema>;

export function parseExecutionCheckpoint(value: unknown): ExecutionCheckpointV1 | null {
  const parsed = executionCheckpointSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
