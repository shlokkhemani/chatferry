import type { ModelInfo, ModelInput, ProviderModelCatalog } from "./types.js";
import { normalizeText } from "./utils.js";

interface StoredModelVariant {
  id: string;
  label: string;
}

interface StoredModelFamily {
  id: string;
  label: string;
  variants: StoredModelVariant[];
}

const STORED_MODEL_FAMILIES: Record<ProviderModelCatalog["provider"], StoredModelFamily[]> = {
  chatgpt: [
    {
      id: "instant",
      label: "Instant",
      variants: [],
    },
    {
      id: "thinking",
      label: "Thinking",
      variants: [
        { id: "light", label: "Light" },
        { id: "standard", label: "Standard" },
        { id: "extended", label: "Extended" },
        { id: "heavy", label: "Heavy" },
      ],
    },
    {
      id: "pro",
      label: "Pro",
      variants: [
        { id: "standard", label: "Standard" },
        { id: "extended", label: "Extended" },
      ],
    },
  ],
  claude: [
    {
      id: "opus-4-6",
      label: "Opus 4.6",
      variants: [
        { id: "standard", label: "Standard" },
        { id: "extended", label: "Extended" },
      ],
    },
    {
      id: "sonnet-4-6",
      label: "Sonnet 4.6",
      variants: [
        { id: "standard", label: "Standard" },
        { id: "extended", label: "Extended" },
      ],
    },
    {
      id: "haiku-4-5",
      label: "Haiku 4.5",
      variants: [
        { id: "standard", label: "Standard" },
        { id: "extended", label: "Extended" },
      ],
    },
  ],
};

export function modelIdFromLabel(label: string): string {
  return normalizeText(label).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildModelInfo(args: {
  family: string | null;
  effort?: string | null;
}): ModelInfo | null {
  const family = args.family?.replace(/\s+/g, " ").trim() ?? null;
  const effort = args.effort?.replace(/\s+/g, " ").trim() ?? null;
  if (!family) {
    return null;
  }

  return {
    label: effort ? `${family}/${effort}` : family,
    family,
    familyId: modelIdFromLabel(family),
    effort,
    effortId: effort ? modelIdFromLabel(effort) : null,
  };
}

export function findMatchingInput(
  catalog: ProviderModelCatalog,
  requested: string,
): ProviderModelCatalog["inputs"][number] | null {
  const normalizedRequested = normalizeText(requested);
  for (const input of catalog.inputs) {
    if (
      normalizedRequested === normalizeText(input.label) ||
      normalizedRequested === input.id
    ) {
      return input;
    }
  }
  return null;
}

export function renderModelCatalog(catalog: ProviderModelCatalog): string[] {
  const lines = [`${catalog.provider} models:`];
  if (catalog.current?.label) {
    lines.push(`Current: ${catalog.current.label}`);
  }
  for (const input of catalog.inputs) {
    lines.push(`${input.selected ? "* " : "- "}${input.label}`);
  }
  return lines;
}

export function storedModelFamilies(
  provider: ProviderModelCatalog["provider"],
): StoredModelFamily[] {
  return STORED_MODEL_FAMILIES[provider];
}

export function storedModelCatalog(
  provider: ProviderModelCatalog["provider"],
  current: ModelInfo | null,
): ProviderModelCatalog {
  const inputs: ModelInput[] = STORED_MODEL_FAMILIES[provider].flatMap<ModelInput>((family) => {
    if (family.variants.length === 0) {
      const label = family.label;
      return [{
        id: modelIdFromLabel(label),
        label,
        selected:
          normalizeText(current?.family ?? "") === normalizeText(family.label) &&
          !current?.effort,
        family: family.label,
        familyId: family.id,
        effort: null,
        effortId: null,
      }];
    }

    return family.variants.map((variant) => {
      const label = `${family.label}/${variant.label}`;
      return {
        id: modelIdFromLabel(label),
        label,
        selected:
          normalizeText(current?.family ?? "") === normalizeText(family.label) &&
          normalizeText(current?.effort ?? "") === normalizeText(variant.label),
        family: family.label,
        familyId: family.id,
        effort: variant.label,
        effortId: variant.id,
      };
    });
  });

  return {
    provider,
    current,
    inputs,
  };
}
