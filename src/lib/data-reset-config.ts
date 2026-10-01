export const DATA_RESET_TARGETS = ["logs", "trading", "research", "all"] as const;
export type DataResetTarget = (typeof DATA_RESET_TARGETS)[number];

export const DATA_RESET_CONFIRMATIONS: Record<DataResetTarget, string> = {
  logs: "CLEAR LOGS",
  trading: "DELETE TRADING DATA",
  research: "DELETE RESEARCH DATA",
  all: "RESET ALL DATA",
};

export const resetRequiresKillSwitch = (target: DataResetTarget) => target !== "logs";
