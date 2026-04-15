# Stage 1: Build the Go Prover from source
FROM golang:1.21-alpine as prover-builder
WORKDIR /app
# Copy the circuit source from the repo root
COPY circuits/ ./circuits/
RUN cd circuits && go build -o /app/prover cmd/prover/main.go

# Stage 2: Python Backend
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY projects/TrustAnchor-backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY projects/TrustAnchor-backend/ .

# Copy the compiled prover from Stage 1
COPY --from=prover-builder /app/prover .

# Ensure binary is executable
RUN chmod +x prover

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
