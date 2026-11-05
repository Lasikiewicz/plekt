# Thin layer for the retiring Plembfin image names.
#
# The Plembfin and Plekt images are the same build. The workflows publish the Plekt
# image first, then build this one on top of it and push it under the legacy names
# (ghcr.io/lasikiewicz/plembfin, plembfin/plembfin). The only difference is the
# flag below, which makes the app show its "this image is being retired" notice.
# It never changes how the app runs. See plan/retire-plembfin-image.md.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ENV PLEKT_LEGACY_IMAGE=1
