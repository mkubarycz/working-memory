# Cruft standalone application template

This directory is a Cookiecutter-compatible Cruft template for independently
deployed, resource-oriented applications. Do not copy it directly. From the
Working Memory repository, generate a project with the repo-pinned wrapper:

```sh
scripts/cruft.sh create . \
  --directory templates/standalone-app \
  --output-dir ../ \
  --no-input \
  --extra-context '{"app_id":"example-app","app_title":"Example App"}'
```

The stable inputs are `app_id`, `app_title`, `app_description`,
`package_name`, `port`, `enable_http`, and `enable_ui`. The generated README
defines the template-owned/app-owned boundary and the `.cruft.json` `skip`
policy for safe updates.

Run the complete disposable lifecycle test with:

```sh
npm run test:standalone-template
```

The harness validates generation, npm install/test/typecheck/build,
subdirectory provenance, drift detection, updates, app-owned preservation,
post-update cleanliness, and `cruft link --directory` capability.
