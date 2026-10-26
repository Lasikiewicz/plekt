import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "netflix_catalogue_updater", Path(__file__).resolve().parents[1] / "scripts" / "update-netflix-catalogue.py"
)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class NetflixCatalogueUpdaterTests(unittest.TestCase):
    def test_movie_sequel_part_is_not_a_series_season(self):
        titles, _ = updater._titles_and_report_title("A Movie: Part 2 // Un Film: Partie 2", "movie")
        self.assertEqual(titles, ["A Movie: Part 2", "Un Film: Partie 2"])

    def test_bilingual_tv_season_labels_are_stripped_together(self):
        titles, report = updater._titles_and_report_title("Squid Game: Season 3 // 오징어 게임: 시즌 3", "tv")
        self.assertEqual(titles, ["Squid Game", "오징어 게임"])
        self.assertIn("Season 3", report)

    def test_genuine_title_colons_survive(self):
        titles, _ = updater._titles_and_report_title("Keep Sweet: Pray and Obey: Limited Series", "tv")
        self.assertEqual(titles, ["Keep Sweet: Pray and Obey"])

    def test_an_unmarked_title_number_is_preserved(self):
        titles, _ = updater._titles_and_report_title("Stranger Things 5", "tv")
        self.assertEqual(titles, ["Stranger Things 5"])

    def test_release_dates_give_a_year_in_either_workbook_format(self):
        self.assertEqual(updater._release_year("2025-03-13"), 2025)
        self.assertEqual(updater._release_year("44931"), 2023)
        self.assertIsNone(updater._release_year(""))
        self.assertIsNone(updater._release_year("-"))

    def test_aggregate_rows_do_not_become_titles(self):
        self.assertIsNone(updater._titles_and_report_title("Other Shows", "tv"))
        self.assertIsNone(updater._titles_and_report_title("Other Movies", "movie"))


if __name__ == "__main__":
    unittest.main()
