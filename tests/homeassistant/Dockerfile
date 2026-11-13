FROM ghcr.io/home-assistant/home-assistant:2026.9.1
COPY custom_components/hksv /config/custom_components/hksv
COPY tests/homeassistant/run.py /tests/run.py
ENTRYPOINT ["python3", "/tests/run.py"]
