"""Report encoding without an HTTP or runtime dependency."""
import csv
import io


def summary_csv(analytics: dict) -> bytes:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['KPI', 'Name', 'Value', 'Target', 'Unit', 'Status'])
    for item in analytics['kpis']:
        writer.writerow([item['id'], item['name'], item['value'], item['target'], item['unit'], item['status']])
    return output.getvalue().encode('utf-8-sig')
