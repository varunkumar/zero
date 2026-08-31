import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Banner } from "./Banner";
import { useTheme } from "./theme";

export interface ModelPickerProps {
  models: string[];
  active: string | null;
  onSelect: (name: string) => void;
  onCancel: () => void;
  cwd: string;
  version: string;
}

export function ModelPicker({ models, active, onSelect, onCancel, cwd, version }: ModelPickerProps) {
  const { theme } = useTheme();
  const start = Math.max(0, models.findIndex((m) => m === active));
  const [index, setIndex] = useState(start);

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (models.length === 0) return;
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(models.length - 1, i + 1));
    else if (key.return) onSelect(models[index]!);
  });

  return (
    <Box flexDirection="column">
      <Banner cwd={cwd} version={version} subtitle="Pick an Ollama model — up/down, enter · esc to cancel" />
      {models.length === 0 ? (
        <Text color="red">no Ollama models found. is ollama running? try: ollama pull &lt;name&gt;</Text>
      ) : models.map((name, i) => (
        <Text key={name} color={i === index ? theme.accent : undefined}>
          {i === index ? "> " : "  "}{name}{name === active ? " *" : ""}
        </Text>
      ))}
    </Box>
  );
}
