# Thin layer that adds the public demo artwork to a released Plekt image.
#
# The normal image leaves public/demo-assets out (about 393 MB that only the public demo
# serves). The workflows publish the Plekt image first, then build this one on top of it
# and push it as <version>-demo; the OCI public demo deploys that tag. It never changes how
# the app runs, only where the demo files come from. See plan/slim-docker-image.md.
#
# Build from the repository root so the folder is in the build context:
#   docker build -f packaging/demo-image/Dockerfile --build-arg BASE_IMAGE=<plekt image> .
# Dockerfile.dockerignore next to this file replaces the root .dockerignore for this build.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=plekt:plekt public/demo-assets ./public/demo-assets
