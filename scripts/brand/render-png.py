#!/usr/bin/env python3
"""Compatibility maintenance entry point: package the supplied logo, never recreate it."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name('generate.py')), run_name='__main__')
