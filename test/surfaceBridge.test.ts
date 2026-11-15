import { assert } from "chai";
import { createSurfaceBridge } from "../src/services/surfaceBridge";

type FakeAdapter = { id: string };

describe("surface bridge", function () {
  it("reports no adapter before an application surface composes one", function () {
    const bridge = createSurfaceBridge<FakeAdapter>("fake");
    assert.isNull(bridge.current());
  });

  it("fails loudly with the bridge name when no adapter is configured", function () {
    const bridge = createSurfaceBridge<FakeAdapter>("fake");
    assert.throws(
      () => bridge.require(),
      "The fake adapter is not configured for this application surface.",
    );
  });

  it("serves the configured adapter to both readers", function () {
    const bridge = createSurfaceBridge<FakeAdapter>("fake");
    const adapter = { id: "first" };
    const restore = bridge.configure(adapter);
    try {
      assert.equal(bridge.current(), adapter);
      assert.equal(bridge.require(), adapter);
    } finally {
      restore();
    }
  });

  it("restores the previous adapter when a configuration is disposed", function () {
    const bridge = createSurfaceBridge<FakeAdapter>("fake");
    const outer = { id: "outer" };
    const inner = { id: "inner" };
    const restoreOuter = bridge.configure(outer);
    const restoreInner = bridge.configure(inner);
    try {
      assert.equal(bridge.current(), inner);
      restoreInner();
      assert.equal(bridge.current(), outer);
    } finally {
      restoreOuter();
    }
    assert.isNull(bridge.current());
    assert.throws(
      () => bridge.require(),
      "The fake adapter is not configured for this application surface.",
    );
  });

  it("leaves a newer adapter in place when a superseded disposer runs late", function () {
    const bridge = createSurfaceBridge<FakeAdapter>("fake");
    const superseded = { id: "superseded" };
    const current = { id: "current" };
    const restoreSuperseded = bridge.configure(superseded);
    const restoreCurrent = bridge.configure(current);
    try {
      restoreSuperseded();
      assert.equal(bridge.current(), current);
    } finally {
      restoreCurrent();
    }
  });

  it("treats an explicit null configuration as an uncomposed surface", function () {
    const bridge = createSurfaceBridge<FakeAdapter>("fake");
    const restore = bridge.configure({ id: "only" });
    const clear = bridge.configure(null);
    try {
      assert.isNull(bridge.current());
      assert.throws(
        () => bridge.require(),
        "The fake adapter is not configured for this application surface.",
      );
    } finally {
      clear();
      restore();
    }
  });
});
