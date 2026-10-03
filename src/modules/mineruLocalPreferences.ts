import { config } from "../../package.json";
import {
  getMineruLocalOptions,
  setMineruLocalOption,
  type MineruLocalOptions,
} from "../utils/mineruConfig";
import type { MineruLocalService } from "../utils/mineruLocalClient";
import { t } from "../utils/i18n";

export function bindMineruLocalPreferences(
  doc: Document,
  onChange: () => void,
) {
  const options = getMineruLocalOptions();
  for (const key of Object.keys(options) as Array<keyof MineruLocalOptions>) {
    const element = doc.getElementById(
      `${config.addonRef}-mineru-local-${key}`,
    ) as HTMLInputElement | HTMLSelectElement | null;
    if (!element) continue;
    if (key === "imageAnalysis")
      (element as HTMLInputElement).checked = options[key];
    else element.value = options[key];
    element.addEventListener("change", () => {
      if (key === "imageAnalysis")
        setMineruLocalOption(key, (element as HTMLInputElement).checked);
      else setMineruLocalOption(key, element.value as never);
      onChange();
    });
  }
  return (service?: MineruLocalService) => {
    for (const api of ["legacy", "v1"] as const) {
      const section = doc.getElementById(
        `${config.addonRef}-mineru-${api}-options`,
      );
      if (section)
        section.style.display =
          service && service.api !== api ? "none" : "flex";
    }
    const select = doc.getElementById(
      `${config.addonRef}-mineru-local-tier`,
    ) as HTMLSelectElement | null;
    if (select)
      for (const option of Array.from(select.options) as HTMLOptionElement[]) {
        option.disabled =
          service?.api === "v1" &&
          option.value !== "auto" &&
          !service.tiers.includes(option.value);
      }
    const status = doc.getElementById(
      `${config.addonRef}-mineru-local-service`,
    );
    if (status)
      status.textContent = service
        ? `MinerU ${service.version} (${service.api === "v1" ? "V1" : t("Legacy API")})`
        : t("Test Connection detects the local API and available options.");
  };
}
