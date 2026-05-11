import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

describe("dashboard", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith("/api/health")) {
        return jsonResponse({
          ok: true,
          alpacaConfigured: false,
          alpacaPaperOnly: true,
          openAiConfigured: false,
          openAiModel: "gpt-5.4-mini",
          dataStore: "data/app-data.json"
        });
      }
      if (target.endsWith("/api/watchlist")) {
        return jsonResponse([
          { symbol: "SPY", tags: ["ETF"], createdAt: "2026-01-01T00:00:00.000Z" }
        ]);
      }
      return jsonResponse({ error: "offline" }, 503);
    });
  });

  it("renders the operating dashboard", async () => {
    render(<App />);

    expect(await screen.findByText("Research Copilot")).toBeInTheDocument();
    expect((await screen.findAllByText("SPY")).length).toBeGreaterThan(0);
    expect(screen.getByText("Run scan")).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    })
  );
}
