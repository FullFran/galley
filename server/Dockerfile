# galley API image: static Go binary (PocketBase uses pure-Go SQLite) on a
# distroless, non-root runtime. Build from the server/ directory:
#   docker build -t galley-api server

# Go version matches go.mod. Digests pin the exact images; refresh them with
# `docker pull <image>` and `docker image inspect --format '{{index .RepoDigests 0}}'`.
FROM golang:1.27-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/galley-api . \
 && mkdir -p /out/pb_data

FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
WORKDIR /pb
COPY --from=build /out/galley-api /pb/galley-api
# Owned by the nonroot user (65532) so a new named volume inherits it.
COPY --from=build --chown=65532:65532 /out/pb_data /pb/pb_data
USER 65532:65532
VOLUME ["/pb/pb_data"]
EXPOSE 8090
ENTRYPOINT ["/pb/galley-api", "--dir=/pb/pb_data", "--encryptionEnv=PB_ENCRYPTION_KEY"]
CMD ["serve", "--http=0.0.0.0:8090", "--origins=https://galley.fullfran.com"]
