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
    throw new AutonomousBudgetAdmissionError(reservation.reason, reservation.policyId);
  }
  return dispatch({
    reservationId: reservation.reservationId,
    replayed: reservation.replayed,
    envelope: reservation.envelope,
  });
}
