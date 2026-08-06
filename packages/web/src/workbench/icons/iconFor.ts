import defaultFile from "../../assets/icons/default_file.svg";
import defaultFolder from "../../assets/icons/default_folder.svg";
import typescript from "../../assets/icons/file_type_typescript.svg";
import reactts from "../../assets/icons/file_type_reactts.svg";
import js from "../../assets/icons/file_type_js.svg";
import reactjs from "../../assets/icons/file_type_reactjs.svg";
import json from "../../assets/icons/file_type_json.svg";
import markdown from "../../assets/icons/file_type_markdown.svg";
import css from "../../assets/icons/file_type_css.svg";
import scss from "../../assets/icons/file_type_scss.svg";
import html from "../../assets/icons/file_type_html.svg";
import image from "../../assets/icons/file_type_image.svg";
import svg from "../../assets/icons/file_type_svg.svg";
import python from "../../assets/icons/file_type_python.svg";
import rust from "../../assets/icons/file_type_rust.svg";
import go from "../../assets/icons/file_type_go.svg";
import shell from "../../assets/icons/file_type_shell.svg";
import yaml from "../../assets/icons/file_type_yaml.svg";
import toml from "../../assets/icons/file_type_toml.svg";
import dotenv from "../../assets/icons/file_type_dotenv.svg";
import git from "../../assets/icons/file_type_git.svg";
import testFile from "../../assets/icons/file_type_testjs.svg";

const EXTENSION_ICONS: Record<string, string> = {
  ts: typescript,
  tsx: reactts,
  js,
  jsx: reactjs,
  json,
  md: markdown,
  mdx: markdown,
  css,
  scss,
  sass: scss,
  html,
  png: image,
  jpg: image,
  jpeg: image,
  gif: image,
  svg,
  py: python,
  rs: rust,
  go,
  sh: shell,
  bash: shell,
  yml: yaml,
  yaml,
  toml,
  env: dotenv,
  gitignore: git,
  test: testFile,
};

/** Maps a file/directory name to a bundled vscode-icons SVG asset URL. */
export function iconFor(name: string, isDir: boolean): string {
  if (isDir) return defaultFolder;
  const dotIndex = name.lastIndexOf(".");
  // Leading-dot files like ".gitignore" have no extension by this rule
  // (dotIndex === 0), so fall back to matching the whole name below.
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1) : "";
  if (ext && EXTENSION_ICONS[ext]) return EXTENSION_ICONS[ext];
  const wholeName = name.startsWith(".") ? name.slice(1) : name;
  return EXTENSION_ICONS[wholeName] ?? defaultFile;
}
