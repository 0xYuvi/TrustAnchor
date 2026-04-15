# Stage 1: Build the Go Prover
FROM golang:1.21-alpine as prover-builder
WORKDIR /app
COPY zkp/ ./zkp/
# Example build command if source is provided
# RUN cd zkp && go build -o prover main.go

# Stage 2: Python Backend
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Ensure the prover binary is executable
RUN chmod +x prover

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
