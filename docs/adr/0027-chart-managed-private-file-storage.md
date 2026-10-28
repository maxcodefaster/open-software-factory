# One installation-owned private file store

The Factory Helm chart includes one pinned single-node Garage service for human attachments,
derived page images, QA recordings and annotation stills. It creates the private bucket,
persistent claim and retained credentials automatically. Requiring an operator to provision
external S3, while keeping QA media on the Factory state volume, made a normal installation
incomplete and split file recovery across unrelated storage paths.

PostgreSQL retains file intent, identities, hashes, references, extracted attachment text and access decisions. File bytes
stay in the common object store, behind authenticated Factory routes. Keys include the retained
installation identity; cleanup deletes only recorded objects. Publication rechecks authority
after storage I/O. Browser video playback streams authenticated byte ranges without exposing
storage credentials or signed URLs.

The chart exposes only capacity, not a menu of storage backends. Kubernetes still needs a usable
StorageClass. The object claim and credentials survive upgrades and uninstall, and must be
backed up together with PostgreSQL. This is not a replicated storage cluster or an automatic
backup service. Existing external files or state-volume media require an explicit retained-data
transfer before switching; an upgrade must not quietly substitute an empty store.

Optional native Forgejo push mirrors preserve central Git at an external Git server. They do
not back up this file store, PostgreSQL, accounts or installation credentials and do not provide
a complete Factory restore. They do not change the chart-managed storage prerequisite.
