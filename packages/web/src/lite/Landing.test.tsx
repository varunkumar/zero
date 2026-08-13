import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Landing } from "./Landing";

test("hasPicker with no pending root shows the Open folder button", () => {
  const html = renderToStaticMarkup(<Landing hasPicker={true} onOpen={() => {}} />);
  expect(html).toContain("Zero Lite");
  expect(html).toContain("Open a local folder in the browser. Chrome or Edge with Gemini Nano required.");
  expect(html).toContain("Open folder");
  expect(html).not.toContain("Reopen");
  expect(html).not.toContain("Chrome or Edge is required for Zero Lite.");
});

test("hasPicker with a pending root shows the Reopen button", () => {
  const html = renderToStaticMarkup(
    <Landing hasPicker={true} pending={{ id: "r1", name: "my-project" }} onOpen={() => {}} onReopen={() => {}} />,
  );
  expect(html).toContain("Open folder");
  expect(html).toContain("Reopen my-project");
});

test("no picker shows the unsupported message and no button", () => {
  const html = renderToStaticMarkup(<Landing hasPicker={false} onOpen={() => {}} />);
  expect(html).toContain("Chrome or Edge is required for Zero Lite.");
  expect(html).not.toContain("Open folder");
  expect(html).not.toContain("Reopen");
});
