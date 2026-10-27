# Desktop artwork and attribution

Factory bundles optimized derivatives of six public-domain paintings. The application stores
one stable local artwork key per Project, shared with all its members. New Projects receive a
random choice among the least-used artworks in their creator's accessible Projects. Project
managers can change that choice. The application does not hotlink these source images.

## River Landscape

- Artist: Annibale Carracci
- Date: c. 1590
- Medium: oil on canvas
- Collection: National Gallery of Art, accession 1952.5.58
- Object: https://www.nga.gov/artworks/41673-river-landscape
- Source image: https://api.nga.gov/iiif/0e373a5e-718d-40a2-bc6b-47be1812459b/full/full/0/default.jpg
- Rights: public domain under the National Gallery of Art Open Access policy

## The Harvesters

- Artist: Pieter Bruegel the Elder
- Date: 1565
- Medium: oil on oak
- Collection: The Metropolitan Museum of Art, object 19.164
- Object: https://www.metmuseum.org/art/collection/search/435809
- Source image: https://images.metmuseum.org/CRDImages/ep/original/DP119115.jpg
- Rights: public domain under The Met Open Access policy

## A Mountainous Landscape with a Waterfall

- Artist: Kerstiaen de Keuninck
- Date: c. 1600
- Medium: oil on wood
- Collection: The Metropolitan Museum of Art, object 1983.452
- Object: https://www.metmuseum.org/art/collection/search/436817
- Source image: https://images.metmuseum.org/CRDImages/ep/original/DP-25738-001.jpg
- Rights: public domain under The Met Open Access policy

## The Gulf of Marseille Seen from L'Estaque

- Artist: Paul Cézanne
- Date: c. 1885
- Medium: oil on canvas
- Collection: The Metropolitan Museum of Art, object 29.100.67
- Object: https://www.metmuseum.org/art/collection/search/435872
- Source image: https://images.metmuseum.org/CRDImages/ep/original/DT1029.jpg
- Rights: public domain under The Met Open Access policy
- Local key: `gulf-of-marseille`; the picker uses the shortened title "The Gulf of Marseille"

## A Scene on the Ice

- Artist: Hendrick Avercamp
- Date: c. 1625
- Medium: oil on panel
- Collection: National Gallery of Art, accession 1967.3.1
- Object: https://www.nga.gov/artworks/50721-scene-ice
- Source image: https://api.nga.gov/iiif/af3e7276-2f9f-47ab-92dd-4a79b4aa9178/full/full/0/default.jpg
- Rights: public domain under the National Gallery of Art Open Access policy
- Local key: `scene-on-the-ice`

## Moonlit Landscape with Bridge

- Artist: Aert van der Neer
- Date: probably 1648/1650
- Medium: oil on panel
- Collection: National Gallery of Art, accession 1990.6.1
- Object: https://www.nga.gov/artworks/71369-moonlit-landscape-bridge
- Source image: https://api.nga.gov/iiif/642620fe-1a26-4ae8-b93a-a84f8c695b60/full/full/0/default.jpg
- Rights: public domain under the National Gallery of Art Open Access policy
- Local key: `moonlit-landscape`

The new backgrounds use JPEG derivatives with a maximum edge of 2560 pixels and separate
360-pixel picker thumbnails. Each artwork has its own crop, tint and contrast treatment.

## Generated skill covers

The `skills/*.webp` files are newly generated skill-cover illustrations, not derivatives of the six
public-domain paintings above. They comprise seven starter covers and one neutral fallback.
Exact generation prompts are recorded in adjacent `.webp.json` sidecars.

## Generated MCP covers

The `mcp/*.webp` files are separately generated connection illustrations in the same print style.
They use landscape crops for Sentry, Datadog and custom sources. They depict connectivity, not
live authorization or provider endorsements. Exact generation prompts are recorded in adjacent
`.webp.json` sidecars.

## Shared library cover catalog

The `library/` directory contains thirty newly generated illustrations in the established
cut-paper and woodcut print style. Each has a 384 × 512 portrait crop for Skills and a 768 × 512
landscape crop for MCP connections. These are two crops of each illustration, not sixty distinct
generated images. Existing Skill and provider covers remain separate.

Generation used the configured development image API with existing Factory covers as style
references. Each `.webp.json` sidecar records the exact prompt, generation timestamp, source
digest and crop. The application serves the finished local files and never calls an image model.
