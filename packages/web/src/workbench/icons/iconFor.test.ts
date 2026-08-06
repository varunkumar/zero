import { describe, expect, test } from "bun:test";
import { iconFor } from "./iconFor";

describe("iconFor", () => {
  test("returns the folder icon for directories regardless of name", () => {
    expect(iconFor("src", true)).toContain("default_folder");
  });

  test.each([
    ["index.ts", "typescript"],
    ["App.tsx", "reactts"],
    ["main.js", "file_type_js"],
    ["Widget.jsx", "reactjs"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["styles.css", "file_type_css"],
    ["app.scss", "scss"],
    ["index.html", "html"],
    ["logo.png", "image"],
    ["icon.svg", "file_type_svg"],
    ["script.py", "python"],
    ["main.rs", "rust"],
    ["main.go", "file_type_go"],
    ["run.sh", "shell"],
    ["config.yaml", "yaml"],
    ["Cargo.toml", "toml"],
    [".env", "dotenv"],
    [".gitignore", "file_type_git"],
  ] as const)("maps %s to an icon containing %s", (name, fragment) => {
    expect(iconFor(name, false)).toContain(fragment);
  });

  test("falls back to the default file icon for unknown extensions", () => {
    expect(iconFor("data.xyz123", false)).toContain("default_file");
  });

  test("falls back to the default file icon for extensionless files", () => {
    expect(iconFor("LICENSE", false)).toContain("default_file");
  });
});
