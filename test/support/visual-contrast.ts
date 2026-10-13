export function luminance(channels: readonly number[]) {
  return channels.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
  }, 0);
}

export function rgb(color: string) {
  const match = color.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
  if (!match) throw new Error(`Expected an RGB color, received ${color}`);
  return { channels: match.slice(1, 4).map(Number), alpha: Number(match[4] ?? 1) };
}
