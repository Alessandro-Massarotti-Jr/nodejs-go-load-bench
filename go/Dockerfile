FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/http ./cmd/http \
 && CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/consumer ./cmd/consumer

# Uma única imagem com os dois binários; o entrypoint é escolhido no deployment.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ /app/
USER nonroot
CMD ["/app/http"]
