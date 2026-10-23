import type { DesktopBackgroundKey } from "../../../packages/interface-domain/src/background";

export type DesktopBackground = {
  key: DesktopBackgroundKey;
  title: string;
  artist: string;
  date: string;
  museum: string;
  image: string;
};

export const desktopBackgrounds: readonly DesktopBackground[] = [
  {
    key: "river-landscape",
    title: "River Landscape",
    artist: "Annibale Carracci",
    date: "c. 1590",
    museum: "National Gallery of Art",
    image: "/art/river-landscape.jpg",
  },
  {
    key: "the-harvesters",
    title: "The Harvesters",
    artist: "Pieter Bruegel the Elder",
    date: "1565",
    museum: "The Metropolitan Museum of Art",
    image: "/art/the-harvesters.jpg",
  },
  {
    key: "mountainous-landscape",
    title: "A Mountainous Landscape with a Waterfall",
    artist: "Kerstiaen de Keuninck",
    date: "c. 1600",
    museum: "The Metropolitan Museum of Art",
    image: "/art/mountainous-landscape.jpg",
  },
  {
    key: "gulf-of-marseille",
    title: "The Gulf of Marseille",
    artist: "Paul Cézanne",
    date: "c. 1885",
    museum: "The Metropolitan Museum of Art",
    image: "/art/gulf-of-marseille.jpg",
  },
  {
    key: "scene-on-the-ice",
    title: "A Scene on the Ice",
    artist: "Hendrick Avercamp",
    date: "c. 1625",
    museum: "National Gallery of Art",
    image: "/art/scene-on-the-ice.jpg",
  },
  {
    key: "moonlit-landscape",
    title: "Moonlit Landscape with Bridge",
    artist: "Aert van der Neer",
    date: "c. 1648/1650",
    museum: "National Gallery of Art",
    image: "/art/moonlit-landscape.jpg",
  },
] as const;

export function orderedDesktopBackgrounds(selectedKey: DesktopBackgroundKey) {
  return [
    ...desktopBackgrounds.filter((background) => background.key === selectedKey),
    ...desktopBackgrounds.filter((background) => background.key !== selectedKey),
  ];
}
