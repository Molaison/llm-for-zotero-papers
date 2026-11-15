import {
  interruptRecoveryScenario,
  resumeRecoveryScenario,
  cleanupRecoveryScenario,
} from "./helpers/mineruRecoveryScenario";

describe("workflow: MinerU durable recovery and retrieval integrity", function () {
  this.timeout(90000);
  for (const mode of ["cancel", "quota"] as const) {
    it(`resumes after ${mode}, publishes verified Markdown and manifest, and retrieves every chapter`, async function () {
      const record = await interruptRecoveryScenario(mode);
      try {
        await resumeRecoveryScenario(record);
      } finally {
        await cleanupRecoveryScenario(record);
      }
    });
  }
});
