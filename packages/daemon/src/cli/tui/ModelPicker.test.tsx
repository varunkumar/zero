import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ModelPicker } from "./ModelPicker";

const tick = () => new Promise((r) => setTimeout(r, 20));

test("lists installed models and marks the active one", () => {
  const { lastFrame } = render(
    <ModelPicker
      models={["llama3.2:latest", "mistral:latest"]}
      active="mistral:latest"
      onSelect={() => {}}
      onCancel={() => {}}
      cwd="/tmp/proj"
      version="0.0.0-test"
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("llama3.2:latest");
  expect(frame).toContain("mistral:latest");
  expect(frame).toContain("mistral:latest *");
});

test("enter on the highlighted row selects that model", async () => {
  let picked: string | undefined;
  const { stdin } = render(
    <ModelPicker
      models={["llama3.2:latest", "mistral:latest"]}
      active="llama3.2:latest"
      onSelect={(name) => { picked = name; }}
      onCancel={() => {}}
      cwd="/tmp/proj"
      version="0.0.0-test"
    />,
  );
  await tick();
  stdin.write("\r");
  expect(picked).toBe("llama3.2:latest");
});

test("down then enter picks the next model", async () => {
  let picked: string | undefined;
  const { stdin } = render(
    <ModelPicker
      models={["llama3.2:latest", "mistral:latest"]}
      active="llama3.2:latest"
      onSelect={(name) => { picked = name; }}
      onCancel={() => {}}
      cwd="/tmp/proj"
      version="0.0.0-test"
    />,
  );
  await tick();
  stdin.write("\u001B[B");
  await tick();
  stdin.write("\r");
  expect(picked).toBe("mistral:latest");
});
