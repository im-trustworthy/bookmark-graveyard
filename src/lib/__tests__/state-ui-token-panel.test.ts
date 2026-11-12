import { describe, expect, it } from "vitest";
import {
  CREATE_CLOSED,
  REVOKE_IDLE,
  canClosePanel,
  canSubmitCreate,
  confirmingId,
  createError,
  createReducer,
  isCreating,
  isPanelOpen,
  isRevokeBusy,
  isRevokingToken,
  revealedToken,
  revokeErrorFor,
  revokeReducer,
} from "@/lib/state/ui/token-panel";
import type { CreateEvent, CreateState, RevokeEvent, RevokeState } from "@/lib/state/ui/token-panel";

describe("create flow", () => {
  const states: Record<CreateState["step"], CreateState> = {
    closed: CREATE_CLOSED,
    form: { step: "form", error: "Name taken." },
    creating: { step: "creating" },
    revealed: { step: "revealed", token: "bg_secret", name: "Grok" },
  };
  const events: Record<CreateEvent["type"], CreateEvent> = {
    open: { type: "open" },
    close: { type: "close" },
    submit: { type: "submit" },
    created: { type: "created", token: "bg_new", name: "New" },
    failed: { type: "failed", message: "Nope." },
    dismissReveal: { type: "dismissReveal" },
  };

  // Every step x event pair; anything not listed is illegal and must hand back the same object.
  const legal: Record<string, CreateState> = {
    "closed/open": { step: "form", error: null },
    "form/close": { step: "closed" },
    "form/submit": { step: "creating" },
    "creating/created": { step: "revealed", token: "bg_new", name: "New" },
    "creating/failed": { step: "form", error: "Nope." },
    "revealed/close": { step: "closed" },
    "revealed/dismissReveal": { step: "form", error: null },
  };

  for (const step of Object.keys(states) as CreateState["step"][]) {
    for (const type of Object.keys(events) as CreateEvent["type"][]) {
      const key = `${step}/${type}`;
      if (key in legal) {
        it(`${key} moves to ${legal[key].step}`, () => {
          expect(createReducer(states[step], events[type])).toEqual(legal[key]);
        });
      } else {
        it(`${key} is ignored`, () => {
          expect(createReducer(states[step], events[type])).toBe(states[step]);
        });
      }
    }
  }

  it("a create that resolves after close reveals nothing", () => {
    let s = createReducer(CREATE_CLOSED, { type: "open" });
    s = createReducer(s, { type: "submit" });
    // Close is refused while the create is in flight, so the panel cannot be closed under it...
    expect(createReducer(s, { type: "close" })).toBe(s);
    // ...and if an answer ever finds the panel closed, it is dropped.
    const closed = createReducer(CREATE_CLOSED, { type: "created", token: "bg_late", name: "Late" });
    expect(closed).toBe(CREATE_CLOSED);
    expect(revealedToken(closed)).toBeNull();
    // Reopening afterwards shows a blank form, not the plaintext.
    expect(createReducer(closed, { type: "open" })).toEqual({ step: "form", error: null });
  });

  it("a create that fails after the panel closed leaves no stale error", () => {
    const closed = createReducer(CREATE_CLOSED, { type: "failed", message: "Late failure." });
    expect(closed).toBe(CREATE_CLOSED);
    expect(createError(createReducer(closed, { type: "open" }))).toBeNull();
  });

  it("selectors", () => {
    expect(isPanelOpen(states.closed)).toBe(false);
    expect(isPanelOpen(states.form)).toBe(true);
    expect(isPanelOpen(states.creating)).toBe(true);
    expect(isPanelOpen(states.revealed)).toBe(true);

    expect(isCreating(states.creating)).toBe(true);
    expect(isCreating(states.form)).toBe(false);

    expect(canClosePanel(states.creating)).toBe(false);
    expect(canClosePanel(states.closed)).toBe(true);
    expect(canClosePanel(states.form)).toBe(true);
    expect(canClosePanel(states.revealed)).toBe(true);

    expect(canSubmitCreate(states.form)).toBe(true);
    expect(canSubmitCreate(states.creating)).toBe(false);
    expect(canSubmitCreate(states.revealed)).toBe(false);
    expect(canSubmitCreate(states.closed)).toBe(false);

    expect(createError(states.form)).toBe("Name taken.");
    expect(createError(states.creating)).toBeNull();
    expect(revealedToken(states.revealed)).toEqual({ token: "bg_secret", name: "Grok" });
    expect(revealedToken(states.form)).toBeNull();
  });
});

describe("revoke flow", () => {
  const states: Record<RevokeState["step"], RevokeState> = {
    idle: REVOKE_IDLE,
    confirming: { step: "confirming", id: "a" },
    revoking: { step: "revoking", id: "a" },
    error: { step: "error", id: "a", message: "Boom." },
  };
  const events: Record<RevokeEvent["type"], RevokeEvent> = {
    ask: { type: "ask", id: "b" },
    cancel: { type: "cancel" },
    confirm: { type: "confirm" },
    revoked: { type: "revoked", id: "a" },
    failed: { type: "failed", id: "a", message: "Nope." },
    reset: { type: "reset" },
  };

  const legal: Record<string, RevokeState> = {
    "idle/ask": { step: "confirming", id: "b" },
    "confirming/ask": { step: "confirming", id: "b" },
    "error/ask": { step: "confirming", id: "b" },
    "confirming/cancel": REVOKE_IDLE,
    "error/cancel": REVOKE_IDLE,
    "confirming/confirm": { step: "revoking", id: "a" },
    "error/confirm": { step: "revoking", id: "a" },
    "revoking/revoked": REVOKE_IDLE,
    "revoking/failed": { step: "error", id: "a", message: "Nope." },
    "confirming/reset": REVOKE_IDLE,
    "revoking/reset": REVOKE_IDLE,
    "error/reset": REVOKE_IDLE,
  };

  for (const step of Object.keys(states) as RevokeState["step"][]) {
    for (const type of Object.keys(events) as RevokeEvent["type"][]) {
      const key = `${step}/${type}`;
      if (key in legal) {
        it(`${key} moves to ${legal[key].step}`, () => {
          expect(revokeReducer(states[step], events[type])).toEqual(legal[key]);
        });
      } else {
        it(`${key} is ignored`, () => {
          expect(revokeReducer(states[step], events[type])).toBe(states[step]);
        });
      }
    }
  }

  it("asking about the token already being confirmed changes nothing", () => {
    expect(revokeReducer(states.confirming, { type: "ask", id: "a" })).toBe(states.confirming);
  });

  it("a revoke failure for another id is ignored", () => {
    expect(revokeReducer(states.revoking, { type: "failed", id: "z", message: "Boom." })).toBe(states.revoking);
    expect(revokeReducer(states.revoking, { type: "revoked", id: "z" })).toBe(states.revoking);
  });

  it("a revoke that fails after the panel closed leaves no error behind", () => {
    const closed = revokeReducer(states.revoking, { type: "reset" });
    expect(revokeReducer(closed, { type: "failed", id: "a", message: "Late." })).toBe(closed);
    expect(revokeErrorFor(closed, "a")).toBeNull();
  });

  it("selectors", () => {
    expect(confirmingId(states.idle)).toBeNull();
    expect(confirmingId(states.confirming)).toBe("a");
    expect(confirmingId(states.revoking)).toBe("a");
    expect(confirmingId(states.error)).toBe("a");

    expect(isRevokeBusy(states.revoking)).toBe(true);
    expect(isRevokeBusy(states.confirming)).toBe(false);
    expect(isRevokeBusy(states.error)).toBe(false);
    expect(isRevokeBusy(states.idle)).toBe(false);

    expect(isRevokingToken(states.revoking, "a")).toBe(true);
    expect(isRevokingToken(states.revoking, "b")).toBe(false);
    expect(isRevokingToken(states.confirming, "a")).toBe(false);

    expect(revokeErrorFor(states.error, "a")).toBe("Boom.");
    expect(revokeErrorFor(states.error, "b")).toBeNull();
    expect(revokeErrorFor(states.revoking, "a")).toBeNull();
  });
});
