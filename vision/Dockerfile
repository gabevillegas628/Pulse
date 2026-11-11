FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY pipeline.py app.py handwriting.py ./
# Railway provides PORT; private networking reaches it at vision.railway.internal:$PORT.
# "::" listens on IPv6 too, which Railway's private network uses. HOST overrides it where
# there is no IPv6 (some local Docker setups).
CMD ["sh", "-c", "uvicorn app:app --host ${HOST:-::} --port ${PORT:-8000} --no-access-log"]
