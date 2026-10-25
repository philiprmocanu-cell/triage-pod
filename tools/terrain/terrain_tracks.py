#!/usr/bin/env python
"""Entry point: same as `python -m tt`. Run with the venv: .venv/bin/python terrain_tracks.py --village 29"""
import sys
from tt.main import main
sys.exit(main())
