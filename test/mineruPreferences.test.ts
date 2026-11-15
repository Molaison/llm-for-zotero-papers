import { assert } from "chai";
import { readFileSync } from "fs";

describe("MinerU preferences", function () {
  let preferences = "";
  let preferenceScript = "";
  let prefs = "";
  let i18n = "";

  before(function () {
    preferences = readFileSync("addon/content/preferences.xhtml", "utf8");
    preferenceScript = readFileSync("src/modules/preferenceScript.ts", "utf8");
    prefs = readFileSync("addon/prefs.js", "utf8");
    i18n = readFileSync("src/utils/i18n.ts", "utf8");
  });

  it("includes Partial in the status legend with the matching purple dot", function () {
    assert.match(
      preferences,
      /Processing[\s\S]*?#8b5cf6;[\s\S]*?Partial[\s\S]*?Failed/,
    );
  });

  it("renders a segmented cloud/local mode chooser instead of the old local checkbox", function () {
    assert.include(preferences, "__addonRef__-mineru-mode-segmented");
    assert.include(preferences, 'role="group"');
    assert.include(preferences, 'aria-label="MinerU parsing mode"');
    assert.include(preferences, 'id="__addonRef__-mineru-mode-cloud"');
    assert.include(preferences, 'data-mineru-mode="cloud"');
    assert.include(preferences, 'id="__addonRef__-mineru-mode-local"');
    assert.include(preferences, 'data-mineru-mode="local"');
    assert.include(preferences, ">Cloud</html:button");
    assert.include(preferences, ">Local</html:button");
    assert.notInclude(preferences, "Use local MinerU server");
  });

  it("keeps segmented mode chooser labels translatable", function () {
    assert.include(i18n, '"MinerU parsing mode"');
    assert.include(i18n, "Cloud:");
    assert.include(i18n, "Local:");
  });

  it("renders a cloud parsing model selector with the supported cloud models", function () {
    assert.include(preferences, "__addonRef__-mineru-cloud-model-section");
    assert.include(preferences, 'for="__addonRef__-mineru-cloud-model"');
    assert.include(preferences, 'id="__addonRef__-mineru-cloud-model"');
    assert.include(preferences, '<html:option value="pipeline">pipeline');
    assert.include(preferences, '<html:option value="vlm">vlm (recommended)');
    assert.include(preferences, "vlm uses a vision-language model");
    assert.include(prefs, 'pref("mineruCloudModel", "vlm");');
  });

  it("offers page-limit presets, Unlimited, and an accessible custom input", function () {
    const selector = preferences.match(
      /<html:select\s+id="__addonRef__-mineru-max-auto-pages-preset"[\s\S]*?<\/html:select>/,
    )?.[0];
    assert.include(prefs, 'pref("mineruMaxAutoPages", 200);');
    assert.isString(selector);
    for (const value of ["100", "200", "500", "1000", "0", "custom"]) {
      assert.include(selector!, `value="${value}"`);
    }
    assert.include(selector!, ">Unlimited</html:option>");
    assert.include(selector!, ">Customized</html:option>");
    assert.include(preferences, 'aria-label="Custom page limit"');
  });

  it("labels the MinerU 4 Auto tier as the best available tier", function () {
    assert.include(
      preferences,
      '<html:option value="auto">Auto (best available)</html:option>',
    );
    assert.notInclude(preferences, "Server default");
    assert.include(i18n, '"Auto (best available)": "自动（最佳可用）"');
  });

  it("renders a shared force OCR option for MinerU parsing", function () {
    assert.include(preferences, 'for="__addonRef__-mineru-force-ocr"');
    assert.include(preferences, 'id="__addonRef__-mineru-force-ocr"');
    assert.include(preferences, "Force OCR");
    assert.include(
      preferences,
      "Use OCR even when MinerU would normally auto-detect PDF text.",
    );
    assert.include(prefs, 'pref("mineruForceOcr", false);');
  });

  it("marks MinerU cloud keys as required and removes keyless proxy copy", function () {
    assert.include(preferences, "An API key is required.");
    assert.include(preferences, "API Key (Required)");
    assert.include(preferences, 'id="__addonRef__-mineru-api-key"');
    assert.include(preferences, 'type="password"');
    assert.include(preferences, "Connects directly to mineru.net.");
    assert.notInclude(preferences, "No API key needed to start");
    assert.notInclude(
      preferences,
      "The built-in MinerU API may no longer be supported",
    );
  });

  it("wires the cloud parsing model selector in the preference script", function () {
    assert.include(preferenceScript, "getMineruCloudModel");
    assert.include(preferenceScript, "setMineruCloudModel");
    assert.include(preferenceScript, "normalizeMineruCloudModel");
    assert.include(preferenceScript, "type MineruCloudModel");
    assert.include(preferenceScript, "mineruCloudModeButton");
    assert.include(preferenceScript, "mineruLocalModeButton");
    assert.include(preferenceScript, "applyMineruModeButtonState");
    assert.include(preferenceScript, "getSelectedMineruApiKeyText");
    assert.include(
      preferenceScript,
      'mineruApiKeyInput.addEventListener("copy"',
    );
    assert.include(preferenceScript, 'clipboardData.setData("text/plain"');
    assert.include(preferenceScript, "mineruCloudModelSection");
    assert.include(preferenceScript, "mineruCloudModelSelect");
    assert.include(preferenceScript, "mineruCloudModelSection.style.display");
    assert.include(preferenceScript, "mineruForceOcrInput");
    assert.include(preferenceScript, "isMineruForceOcrEnabled");
    assert.include(preferenceScript, "setMineruForceOcrEnabled");
    assert.include(preferenceScript, 'mode === "cloud" ? "flex" : "none"');
    assert.include(preferenceScript, "Enter your MinerU API key first");
    assert.notInclude(preferenceScript, "mineruLocalModeInput");
    assert.notInclude(preferenceScript, "testProxyConnection");
  });
});
