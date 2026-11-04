# Third-Party Notices — PostgreSQL media

This directory is the PostgreSQL delivery template for the LIONS open-source
install medium. It does not contain the PostgreSQL server binary itself.

## 1. PostgreSQL

- Component: PostgreSQL 16 (server / client tools)
- License: PostgreSQL License (permissive, OSI-approved)
- Text: [LICENSE-postgresql.txt](LICENSE-postgresql.txt)
- Source: https://www.postgresql.org/about/licence/

The PostgreSQL License allows commercial use, modification and redistribution
provided the copyright and license notices are retained. It does not require
source disclosure.

## 2. If you distribute a Docker image tar

An image such as postgres:16-alpine or postgres:16 contains more than
PostgreSQL: Alpine or Debian base packages, BusyBox (GPLv2), musl (MIT),
OpenSSL (Apache-2.0), and others.

If you redistribute an image tar, you are redistributing those components too:

- include their license notices;
- for GPL/LGPL components, provide a written offer or a source URL;
- record the image digest (repo@sha256:...) in bundle.json.

If you only ship compose.yml and let the user docker pull, you are not
redistributing the image; requirements are lighter but the user needs network.

## 3. If you distribute .deb packages

Keep each package's /usr/share/doc/<package>/copyright. Do not bundle arbitrary
OS libraries; let apt resolve dependencies, or list them explicitly.

## 4. Trademark

"PostgreSQL" is a trademark of the PostgreSQL Community Association. Nominative
use ("includes PostgreSQL") is fine. Do not use the PostgreSQL logo as your
product name or imply official endorsement.

See https://www.postgresql.org/about/policies/trademarks/

## 5. What this repository ships

This repository ships only compose.yml, bundle.json.example and the notices
above. It does not ship a PostgreSQL binary or image. Media builders that add
postgres-*.tar or deb/*.deb must add the corresponding notices/source offer.
