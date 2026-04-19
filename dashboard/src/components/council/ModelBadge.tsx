import { modelHue } from './lib/councilStats';

interface Props {
  model: string;
}

export function ModelBadge({ model }: Props) {
  const hue = modelHue(model);
  const display = model ? model.charAt(0).toUpperCase() + model.slice(1) : 'unknown';
  return (
    <span
      className="council-model-badge"
      style={{
        background: `hsl(${hue} 85% 55% / 0.14)`,
        color: `hsl(${hue} 85% 40%)`,
        borderColor: `hsl(${hue} 85% 55% / 0.35)`,
      }}
      title={`Model: ${display}`}
    >
      {display}
    </span>
  );
}
