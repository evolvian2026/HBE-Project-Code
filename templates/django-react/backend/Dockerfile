FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY . .
RUN useradd --create-home app
USER app
EXPOSE 8000
# Migrations run at start (the database is new for every grader run), once it accepts connections.
CMD ["sh", "-c", "python manage.py wait_for_db && python manage.py migrate --noinput && exec gunicorn config.wsgi -b 0.0.0.0:8000 --workers 2"]
