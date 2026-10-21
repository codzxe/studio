// onboarding-storage tests — persistence seams with an injected fake storage;
// no DOM, no network (the browser path is guarded by typeof window checks).

import { describe, expect, it } from "vitest";
import {
  CHECKLIST_CHANGED_EVENT,
  CHECKLIST_STORAGE_KEY,
  markChecklistStepDone,
  readChecklistSteps,
  readCelebratedAt,
  writeCelebratedAt,
  writeChecklistSteps,
  type SafeStorage,
} from "./onboarding-storage";
import {
  emptyChecklistSteps,
  markChecklistStep,
  serializeChecklistSteps,
} from "./checklist-model";

class FakeStorage implements SafeStorage {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("readChecklistSteps", () => {
  it("returns nothing-done for a null storage", () => {
    expect(readChecklistSteps(null)).toEqual(emptyChecklistSteps());
  });

  it("returns nothing-done for a missing or junk payload", () => {
    const storage = new FakeStorage();
    expect(readChecklistSteps(storage)).toEqual(emptyChecklistSteps());
    storage.setItem(CHECKLIST_STORAGE_KEY, "{not json");
    expect(readChecklistSteps(storage)).toEqual(emptyChecklistSteps());
  });

  it("reads back persisted steps", () => {
    const storage = new FakeStorage();
    const steps = markChecklistStep(emptyChecklistSteps(), "first-prompt");
    storage.setItem(CHECKLIST_STORAGE_KEY, serializeChecklistSteps(steps));
    expect(readChecklistSteps(storage)).toEqual(steps);
  });
});

describe("writeChecklistSteps", () => {
  it("is a no-op (never throws) with a null storage", () => {
    expect(() =>
      writeChecklistSteps(null, markChecklistStep(emptyChecklistSteps(), "export-design")),
    ).not.toThrow();
  });

  it("persists only true keys", () => {
    const storage = new FakeStorage();
    writeChecklistSteps(
      storage,
      markChecklistStep(emptyChecklistSteps(), "trial-grant"),
    );
    expect(storage.map.get(CHECKLIST_STORAGE_KEY)).toBe('{"trial-grant":true}');
  });
});

describe("markChecklistStepDone", () => {
  it("persists and returns the new state", () => {
    const storage = new FakeStorage();
    const next = markChecklistStepDone("pick-template", storage);
    expect(next["pick-template"]).toBe(true);
    expect(readChecklistSteps(storage)).toEqual(next);
  });

  it("is idempotent across repeated calls", () => {
    const storage = new FakeStorage();
    markChecklistStepDone("first-prompt", storage);
    const again = markChecklistStepDone("first-prompt", storage);
    expect(again["first-prompt"]).toBe(true);
    expect(readChecklistSteps(storage)).toEqual(again);
  });

  it("tolerates a null storage (blocked localStorage degrades gracefully)", () => {
    const next = markChecklistStepDone("export-design", null);
    expect(next["export-design"]).toBe(true);
  });
});

describe("celebration flag", () => {
  it("round-trips the celebrated timestamp", () => {
    const storage = new FakeStorage();
    expect(readCelebratedAt(storage)).toBeNull();
    writeCelebratedAt(storage, "2025-01-01T00:00:00.000Z");
    expect(readCelebratedAt(storage)).toBe("2025-01-01T00:00:00.000Z");
  });

  it("reads null when storage is null", () => {
    expect(readCelebratedAt(null)).toBeNull();
    expect(writeCelebratedAt(null, "x")).toBe("x");
  });
});

describe("sync event name", () => {
  it("is namespaced to avoid collisions with other window events", () => {
    expect(CHECKLIST_CHANGED_EVENT).toBe("onboarding:checklist-changed");
  });
});
