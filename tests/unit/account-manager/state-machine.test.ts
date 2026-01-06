/**
 * State Machine Tests: Account Lifecycle
 *
 * Tests account state transitions:
 *   active -> rate_limited -> recovering -> active
 *   active -> invalid (terminal)
 */

import { describe, it, expect, beforeEach } from "vitest";

// State definitions
type AccountState = "active" | "rate_limited" | "recovering" | "invalid";

interface AccountStateInfo {
  state: AccountState;
  rateLimitResetTime?: number;
  lastError?: string;
}

// Mock account state manager for testing transitions
class AccountStateMachine {
  private states: Map<string, AccountStateInfo> = new Map();

  getState(accountId: string): AccountStateInfo {
    return this.states.get(accountId) ?? { state: "active" };
  }

  markRateLimited(accountId: string, resetTime: number): void {
    this.states.set(accountId, {
      state: "rate_limited",
      rateLimitResetTime: resetTime,
    });
  }

  markRecovering(accountId: string): void {
    const current = this.states.get(accountId);
    if (current?.state === "rate_limited") {
      this.states.set(accountId, { state: "recovering" });
    }
  }

  markActive(accountId: string): void {
    const current = this.states.get(accountId);
    if (current?.state !== "invalid") {
      this.states.set(accountId, { state: "active" });
    }
  }

  markInvalid(accountId: string, error: string): void {
    this.states.set(accountId, { state: "invalid", lastError: error });
  }

  isUsable(accountId: string): boolean {
    const info = this.getState(accountId);
    return info.state === "active" || info.state === "recovering";
  }
}

describe("Account State Machine", () => {
  let machine: AccountStateMachine;

  beforeEach(() => {
    machine = new AccountStateMachine();
  });

  describe("Initial State", () => {
    it("starts in active state", () => {
      const state = machine.getState("account-1");
      expect(state.state).toBe("active");
    });

    it("is usable when active", () => {
      expect(machine.isUsable("account-1")).toBe(true);
    });
  });

  describe("State Transitions: active -> rate_limited", () => {
    it("transitions to rate_limited when rate limit hit", () => {
      const resetTime = Date.now() + 60000;
      machine.markRateLimited("account-1", resetTime);

      const state = machine.getState("account-1");
      expect(state.state).toBe("rate_limited");
      expect(state.rateLimitResetTime).toBe(resetTime);
    });

    it("is not usable when rate_limited", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      expect(machine.isUsable("account-1")).toBe(false);
    });
  });

  describe("State Transitions: rate_limited -> recovering", () => {
    it("transitions to recovering after reset time", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markRecovering("account-1");

      const state = machine.getState("account-1");
      expect(state.state).toBe("recovering");
    });

    it("is usable when recovering", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markRecovering("account-1");
      expect(machine.isUsable("account-1")).toBe(true);
    });

    it("cannot transition to recovering from active", () => {
      machine.markRecovering("account-1");
      const state = machine.getState("account-1");
      expect(state.state).toBe("active"); // No change
    });
  });

  describe("State Transitions: recovering -> active", () => {
    it("transitions back to active on successful request", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markRecovering("account-1");
      machine.markActive("account-1");

      const state = machine.getState("account-1");
      expect(state.state).toBe("active");
    });
  });

  describe("State Transitions: any -> invalid", () => {
    it("transitions to invalid on auth error", () => {
      machine.markInvalid("account-1", "invalid_grant");

      const state = machine.getState("account-1");
      expect(state.state).toBe("invalid");
      expect(state.lastError).toBe("invalid_grant");
    });

    it("is not usable when invalid", () => {
      machine.markInvalid("account-1", "token_revoked");
      expect(machine.isUsable("account-1")).toBe(false);
    });

    it("cannot recover from invalid state", () => {
      machine.markInvalid("account-1", "token_revoked");
      machine.markActive("account-1");

      const state = machine.getState("account-1");
      expect(state.state).toBe("invalid"); // Still invalid
    });
  });

  describe("Multiple Accounts", () => {
    it("tracks state independently per account", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markInvalid("account-2", "error");
      // account-3 remains active

      expect(machine.getState("account-1").state).toBe("rate_limited");
      expect(machine.getState("account-2").state).toBe("invalid");
      expect(machine.getState("account-3").state).toBe("active");
    });

    it("reports correct usable accounts", () => {
      machine.markRateLimited("account-1", Date.now() + 60000);
      machine.markInvalid("account-2", "error");
      machine.markRecovering("account-1");

      expect(machine.isUsable("account-1")).toBe(true); // recovering
      expect(machine.isUsable("account-2")).toBe(false); // invalid
      expect(machine.isUsable("account-3")).toBe(true); // active
    });
  });

  describe("Full Lifecycle", () => {
    it("completes full recovery cycle", () => {
      // Start active
      expect(machine.getState("account-1").state).toBe("active");

      // Hit rate limit
      machine.markRateLimited("account-1", Date.now() + 1000);
      expect(machine.getState("account-1").state).toBe("rate_limited");
      expect(machine.isUsable("account-1")).toBe(false);

      // Reset time passes, start recovering
      machine.markRecovering("account-1");
      expect(machine.getState("account-1").state).toBe("recovering");
      expect(machine.isUsable("account-1")).toBe(true);

      // Successful request, back to active
      machine.markActive("account-1");
      expect(machine.getState("account-1").state).toBe("active");
      expect(machine.isUsable("account-1")).toBe(true);
    });
  });
});
