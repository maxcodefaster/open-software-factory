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
] as const;
