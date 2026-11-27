---
simt-id: php
simt-title: PHP
simt-applies: [has-composer]
simt-priority: convention
simt-scope: ["composer.json", "composer.lock", "phpunit.xml", "phpunit.xml.dist", "**/*.php"]
---

# Stack profile: PHP

Applies to: PHP applications and libraries with a committed `composer.json`.

## Composer and commands

- The scripts in `composer.json` are the repository's command contract. Run a declared
  script with `composer run <script>`; do not invent `composer test`, `composer lint` or
  another script the repository does not define.
- Restore dependencies with `composer install`. An application commits
  `composer.lock`; a library that intentionally does not is a documented packaging
  decision, not a reason to create a lockfile silently.
- `composer validate --strict` is the manifest lint gate. Do not run `composer update`
  merely to make it pass: dependency constraints and the lockfile change together and
  need their own review.
- Use project-local binaries under `vendor/bin` or `composer exec <tool>`. Never assume
  a global `phpunit`, `phpcs` or other console command belongs to this repository.

## Types and style

- New PHP files declare `declare(strict_types=1);` and use typed parameters, return
  types and properties where the supported PHP version allows them.
- Follow PSR-12: four-space indentation, braces on their own lines for classes and
  methods, ordered imports and one class per file. Keep the repository's existing
  formatter configuration authoritative.
- Model invalid states with exceptions or explicit error results. Do not suppress a
  failure merely to keep a request alive; preserve its cause for the caller.

## Tests

- Use the repository's PHPUnit configuration. The focused form is
  `vendor/bin/phpunit {file}`; when the repository declares a Composer test script,
  that script is the full-suite entrypoint.
- Assert observable behaviour through the public interface. A test that only verifies
  a mock was called proves the wiring, not the result.
- Keep unit tests independent of live databases and network services. Use the test
  configuration the repository provides for fixtures and isolation.
