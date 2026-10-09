from django.db import models


class Note(models.Model):
    """The example resource. Replace it with your assignment's."""

    title = models.CharField(max_length=200)
    done = models.BooleanField(default=False)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.title
