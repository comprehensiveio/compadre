import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "../ui/tooltip";
import {
  CompadreConversationFilter,
  CompadreSlackThreadLink,
  ThreadParticipantAvatars,
} from "./CompadreSidebar";

const participants = [
  {
    userId: "alice",
    displayName: "Alice Example",
    avatarUrl: "/alice.png",
    origins: ["slack" as const],
  },
  { userId: "bob", displayName: "Bob Example", origins: ["web" as const] },
  { userId: "carol", displayName: "Carol Example", origins: ["web" as const] },
  { userId: "dan", displayName: "Dan Example", origins: ["slack" as const] },
];

describe("Compadre sidebar presentation", () => {
  it.each(["involved", "started-by-me", "all"] as const)(
    "keeps the identity controls and selected state for %s",
    (value) => {
      const onChange = vi.fn();
      const element = CompadreConversationFilter({ value, onChange });
      const markup = renderToStaticMarkup(element);
      expect(markup).toContain('aria-label="Filter conversations"');
      expect(markup).toContain("With me");
      expect(markup).toContain("Started by me");
      expect(markup).toContain(">All</button>");
      expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
      const buttons = element.props.children as ReactElement<{
        "aria-pressed": boolean;
        onClick: () => void;
      }>[];
      expect(buttons.find((button) => button.props["aria-pressed"])?.key).toBe(value);
      for (const button of buttons) {
        button.props.onClick();
        expect(onChange).toHaveBeenLastCalledWith(button.key);
      }
    },
  );

  it.each([false, true])("shows photos, initials and overflow in compact=%s rows", (compact) => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ThreadParticipantAvatars thread={{ participants }} compact={compact} />
      </TooltipProvider>,
    );
    expect(markup).toContain('src="/alice.png"');
    expect(markup).toContain(
      'aria-label="Participants: Alice Example, Bob Example, Carol Example, Dan Example"',
    );
    expect(markup).toContain(">BE</span>");
    expect(markup).toContain(">+1</span>");
    expect(markup).not.toContain(">DE</span>");
  });

  it("retains an empty-participant placeholder", () => {
    const markup = renderToStaticMarkup(<ThreadParticipantAvatars thread={{}} />);
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("<img");
  });

  it("links to the Slack thread without activating the enclosing thread row", () => {
    const url = "https://example.slack.com/archives/C_TEST/p1234567890";
    const element = CompadreSlackThreadLink({ reference: { provider: "slack", url } });
    const markup = renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);
    expect(markup).toContain(`href="${url}"`);
    expect(markup).toContain('aria-label="Open Slack thread"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    const anchor = element.props.children[0].props.render;
    for (const eventName of ["onPointerDown", "onClick", "onDoubleClick", "onKeyDown"]) {
      const stopPropagation = vi.fn();
      anchor.props[eventName]({ stopPropagation });
      expect(stopPropagation).toHaveBeenCalledOnce();
    }
  });
});
