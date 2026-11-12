// The Assistants panel's two flows as explicit state machines: creating a token
// (and showing its plaintext once) and revoking one. Pure: no React, no fetch.
// An event that is illegal in the current state returns the same state object,
// so a response that arrives after the panel moved on changes nothing.

// --- Create ------------------------------------------------------------------

export type CreateState =
  | { step: "closed" }
  | { step: "form"; error: string | null }
  | { step: "creating" }
  | { step: "revealed"; token: string; name: string };

export type CreateEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "submit" }
  | { type: "created"; token: string; name: string }
  | { type: "failed"; message: string }
  | { type: "dismissReveal" };

export const CREATE_CLOSED: CreateState = { step: "closed" };

export function createReducer(state: CreateState, event: CreateEvent): CreateState {
  switch (event.type) {
    case "open":
      return state.step === "closed" ? { step: "form", error: null } : state;
    case "close":
      // Not while a create is in flight: its answer would otherwise land on a closed panel.
      return state.step === "form" || state.step === "revealed" ? CREATE_CLOSED : state;
    case "submit":
      return state.step === "form" ? { step: "creating" } : state;
    case "created":
      // Only the create that is waiting for an answer may reveal a token.
      return state.step === "creating" ? { step: "revealed", token: event.token, name: event.name } : state;
    case "failed":
      return state.step === "creating" ? { step: "form", error: event.message } : state;
    case "dismissReveal":
      return state.step === "revealed" ? { step: "form", error: null } : state;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export const isPanelOpen = (s: CreateState): boolean => s.step !== "closed";
export const isCreating = (s: CreateState): boolean => s.step === "creating";
export const canClosePanel = (s: CreateState): boolean => s.step !== "creating";
export const canSubmitCreate = (s: CreateState): boolean => s.step === "form";
export const createError = (s: CreateState): string | null => (s.step === "form" ? s.error : null);
export const revealedToken = (s: CreateState): { token: string; name: string } | null =>
  s.step === "revealed" ? { token: s.token, name: s.name } : null;

// --- Revoke ------------------------------------------------------------------

export type RevokeState =
  | { step: "idle" }
  | { step: "confirming"; id: string }
  | { step: "revoking"; id: string }
  | { step: "error"; id: string; message: string };

export type RevokeEvent =
  | { type: "ask"; id: string }
  | { type: "cancel" }
  | { type: "confirm" }
  | { type: "revoked"; id: string }
  | { type: "failed"; id: string; message: string }
  | { type: "reset" };

export const REVOKE_IDLE: RevokeState = { step: "idle" };

export function revokeReducer(state: RevokeState, event: RevokeEvent): RevokeState {
  switch (event.type) {
    case "ask":
      // Another token's Revoke button stays live while one is being confirmed or has failed.
      if (state.step === "revoking") return state;
      if (state.step === "confirming" && state.id === event.id) return state;
      return { step: "confirming", id: event.id };
    case "cancel":
      return state.step === "confirming" || state.step === "error" ? REVOKE_IDLE : state;
    case "confirm":
      // From error this is the retry.
      return state.step === "confirming" || state.step === "error" ? { step: "revoking", id: state.id } : state;
    case "revoked":
      return state.step === "revoking" && state.id === event.id ? REVOKE_IDLE : state;
    case "failed":
      return state.step === "revoking" && state.id === event.id
        ? { step: "error", id: event.id, message: event.message }
        : state;
    case "reset":
      // The panel closed: nothing is left to confirm, and a late answer finds nothing to update.
      return state.step === "idle" ? state : REVOKE_IDLE;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** The id whose confirm group is showing, in any step that shows one. */
export const confirmingId = (s: RevokeState): string | null => (s.step === "idle" ? null : s.id);
export const isRevokeBusy = (s: RevokeState): boolean => s.step === "revoking";
export const isRevokingToken = (s: RevokeState, id: string): boolean => s.step === "revoking" && s.id === id;
export const revokeErrorFor = (s: RevokeState, id: string): string | null =>
  s.step === "error" && s.id === id ? s.message : null;
