import { assert } from "chai";
import {
  createUserIdleTracker,
  setUserIdleForTests,
} from "../src/services/libraryTextIndex/userIdle";

describe("library text index user idle tracker", function () {
  const previousCc = (globalThis as any).Components;
  afterEach(function () {
    (globalThis as any).Components = previousCc;
    setUserIdleForTests(null);
  });

  it("observes nsIUserIdleService idle/active topics", function () {
    const observers: Array<{ observe: (s: unknown, topic: string) => void }> =
      [];
    (globalThis as any).Components = {
      classes: {
        "@mozilla.org/widget/useridleservice;1": {
          getService: () => ({
            addIdleObserver: (o: any) => observers.push(o),
            removeIdleObserver: (o: any) =>
              observers.splice(observers.indexOf(o), 1),
          }),
        },
      },
      interfaces: { nsIUserIdleService: {} },
    };
    const tracker = createUserIdleTracker(60);
    const seen: boolean[] = [];
    tracker.onChange((idle) => seen.push(idle));
    assert.isFalse(tracker.isIdle(), "not idle until the service says so");
    observers[0].observe(null, "idle");
    assert.isTrue(tracker.isIdle());
    observers[0].observe(null, "active");
    assert.isFalse(tracker.isIdle());
    assert.deepEqual(seen, [true, false]);
    tracker.dispose();
    assert.lengthOf(observers, 0);
  });

  it("falls back to idle=true when the service is unavailable and honours the test override", function () {
    (globalThis as any).Components = undefined;
    const tracker = createUserIdleTracker(60);
    assert.isTrue(tracker.isIdle());
    setUserIdleForTests(false);
    assert.isFalse(tracker.isIdle());
    tracker.dispose();
  });
});
