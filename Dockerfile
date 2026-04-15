# Stage 1: Build the Go Prover from source
FROM golang:1.24-alpine as prover-builder
# Install build dependencies for C-go / crypto
RUN apk add --no-cache build-base
WORKDIR /app
# Copy the entire circuits directory (including go.mod/sum)
COPY circuits/ ./circuits/
RUN cd circuits && go build -o /app/prover ./cmd/prover/main.go

# Stage 2: Python Backend
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# Copy backend requirements and install
COPY projects/TrustAnchor-backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the entire backend folder into /app
COPY projects/TrustAnchor-backend/ .

# Copy the compiled prover from Stage 1 into the same /app folder
COPY --from=prover-builder /app/prover .

# Ensure binary is executable
RUN chmod +x prover

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=10000

# Expose Render's default port or use the override
EXPOSE 10000

# Start the application using the PORT env var provided by Render
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000}"]
