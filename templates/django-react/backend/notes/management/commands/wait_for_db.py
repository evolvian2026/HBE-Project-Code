import time

from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.utils import OperationalError


class Command(BaseCommand):
    help = "Waits until the database accepts connections (it may start after the app)."

    def handle(self, *args, **options):
        for _ in range(60):
            try:
                connection.ensure_connection()
                return
            except OperationalError:
                self.stdout.write("Waiting for the database...")
                time.sleep(2)
        raise CommandError("The database did not become available within 2 minutes.")
