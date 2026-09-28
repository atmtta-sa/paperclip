import type { Db } from "@paperclipai/db";
import {
  reserveAutonomousBudget,
  type AutonomousBudgetReservationInput,
  type AutonomousBudgetEnvelope,
  type BudgetBlockReason,
} from "./autonomous-budget-reservations.js";

export class AutonomousBudgetAdmissionError extends Error {
  readonly reason: BudgetBlockReason;
  readonly policyId: string;

  constructor(reason: BudgetBlockReason, policyId: string) {
    super(`${reason}:${policyId}`);
    this.name = "AutonomousBudgetAdmissionError";
    this.reason = reason;
    this.policyId = policyId;
  }
}

export class AutonomousExecutionPausedError extends Error {
  readonly reason = "autonomous_execution_paused";
  constructor() {
    super("autonomous_execution_paused");
    this.name = "AutonomousExecutionPausedError";
  }
}

export class AutonomousProviderCircuitAdmissionError extends Error {
  readonly reason: "provider_circuit_open" | "provider_circuit_probe_in_flight";
  readonly retryAt: Date | null;

  constructor(
    reason: "provider_circuit_open" | "provider_circuit_probe_in_flight",
    retryAt: Date | null,
  ) {
    super(reason);
    this.name = "AutonomousProviderCircuitAdmissionError";
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

export function isAutonomousBudgetAdmissionError(
  error: unknown,
): error is AutonomousBudgetAdmissionError {
  return error instanceof AutonomousBudgetAdmissionError;
}

export async function dispatchWithAutonomousBudgetReservation<T>(
  db: Db,
  input: AutonomousBudgetReservationInput,
  dispatch: (reservation: {
    reservationId: string;
    replayed: boolean;
    envelope: AutonomousBudgetEnvelope;
  }) => Promise<T>,
): Promise<T> {
  const reservation = await reserveAutonomousBudget(db, input);
  if (!reservation.admitted) {
    if (reservation.reason === "autonomous_execution_paused") {
      throw new AutonomousExecutionPausedError();
    }
    if (
      reservation.reason === "provider_circuit_open" ||
      reservation.reason === "provider_circuit_probe_in_flight"
    ) {
      throw new AutonomousProviderCircuitAdmissionError(
        reservation.reason,
        reservation.retryAt,
      );
    }
    if ("policyId" in reservation) {
      throw new AutonomousBudgetAdmissionError(reservation.reason, reservation.policyId);
    }
    throw new Error(`Unhandled autonomous admission denial: ${reservation.reason}`);
  }
  return dispatch({
    reservationId: reservation.reservationId,
    replayed: reservation.replayed,
    envelope: reservation.envelope,
  });
}
