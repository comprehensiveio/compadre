import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";

const state = vi.hoisted(() => ({ hosted: true, pathname: "/", pullRequests: true }));
vi.mock("../../branding", () => ({
  get COMPADRE_AUTH_ENABLED() {
    return state.hosted;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) => select(state),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { serverConfig: { environment: { capabilities: { pullRequests: state.pullRequests } } } },
    ],
  }),
}));
vi.mock("./SidebarUpdatePill", () => ({ SidebarUpdatePill: () => null }));

import { SidebarUtilityMenu } from "./SidebarChrome";

function renderMenu() {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarUtilityMenu />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

describe("Compadre sidebar navigation", () => {
  beforeEach(() => {
    state.hosted = true;
    state.pathname = "/";
    state.pullRequests = true;
  });
  it("keeps hosted operations and sign-out alongside upstream utilities", () => {
    const markup = renderMenu();
    for (const label of ["Settings", "Pull Requests", "Usage", "Thread environments", "Sign out"]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
  });
  it("does not advertise hosted controls in the standalone local app", () => {
    state.hosted = false;
    const markup = renderMenu();
    expect(markup).not.toContain('aria-label="Thread environments"');
    expect(markup).not.toContain('aria-label="Sign out"');
    expect(markup).toContain('aria-label="Settings"');
  });
  it("offers a way back from thread environments", () => {
    state.pathname = "/operations/threads";
    const markup = renderMenu();
    expect(markup).toContain(">Back</span>");
    expect(markup).not.toContain('aria-label="Thread environments"');
  });
  it("retains hosted operations when pull requests are unsupported", () => {
    state.pullRequests = false;
    const markup = renderMenu();
    expect(markup).not.toContain('aria-label="Pull Requests"');
    expect(markup).toContain('aria-label="Thread environments"');
  });
});
