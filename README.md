# Torus Power Hybrid Scraper

Node.js scraper designed to monitor **Torus Power AVR** units by collecting metrics from both the **Torus Power Connect cloud dashboard** and the device's **local web interface**.

It pushes these metrics to a **Prometheus Pushgateway** for visualization in Grafana.

## Features

  * **Hybrid Polling:**
      * Prioritizes high-quality data (Decimal precision, THD, Timestamps) from the Cloud.
      * Automatically falls back to local device scraping if the cloud data is stale (\> 60 seconds).
  * **Robust Cloud Auth:** Automatically handles complex ASP.NET logins, redirects, and dynamic button finding.
  * **Smart Rate Limiting:** Limits local device scraping to a configurable interval (default: 5 mins) to prevent overloading the embedded web server, caching data in between.
  * **Cloud Back-off Strategy:** If the cloud connection is down for an extended period, the scraper intelligently backs off checking the cloud (wait time = 50% of outage duration) to reduce load, while continuing to serve cached local data.
  * **Data Source Tagging:** Metrics include a `torus_data_source` label to indicate origin:
      * 0: **Cloud (Fresh)**
      * 1: **Local (Fresh Fallback)**
      * 2: **Cloud (Stale)** - Cloud is old, and local fallback failed/unavailable.
      * 3: **Local (Cached)** - Cloud is old, reusing cached local data due to rate limits.
  * **Drift Correction:** Ensures polling loops run at precise intervals (e.g., every 15s).
  * **Timezone Awareness:** Correctly parses device timestamps relative to your local timezone.

## Prerequisites

  * Docker
  * Kubernetes Cluster (optional, for CronJob deployment)
  * Prometheus Pushgateway

## Configuration

The scraper is configured entirely via Environment Variables.

| **Variable**             | **Description**                                                            | **Default** | **Required?**                     |
| :----------------------: | :------------------------------------------------------------------------: | :---------: | :-------------------------------: |
| `TORUS_USERNAME`         | Cloud login email/username                                                 | None        | **Yes**                           |
| `TORUS_PASSWORD`         | Cloud login password                                                       | None        | **Yes**                           |
| `PUSHGATEWAY_URL`        | URL of your Pushgateway                                                    | None        | **Yes**                           |
| `TORUS_LOCAL_URL`        | IP/URL of local device (e.g. \[http://192.168.1.50\](http://192.168.1.50)) | None        | No (but recommended for fallback) |
| `DEVICE_TIMEZONE_OFFSET` | Device timezone offset from UTC (e.g. -5 for EST)                          | 0           | No                                |
| `JOB_DURATION`           | How long the script runs before exiting (seconds)                          | 280         | No                                |
| `POLL_INTERVAL`          | How often to fetch data within the loop (seconds)                          | 15          | No                                |
| `LOCAL_SCRAPE_INTERVAL`  | Min seconds between local scrapes (Rate Limit)                             | 300         | No                                |
| `ENABLE_CLOUD_BACKOFF`   | Enable/Disable the cloud check back-off strategy                           | true        | No                                |

## Building & Running

### 1\. Local Docker Build

1.  **Build the image:**
    ``` bash
    docker build -t your-username/torus-scraper:v1 .
    
    ```
2.  **Run locally (for testing):**
    ``` bash
    docker run --rm \
      -e TORUS_USERNAME="your-email" \
      -e TORUS_PASSWORD="your-pass" \
      -e PUSHGATEWAY_URL="http://pushgateway:9091" \
      -e TORUS_LOCAL_URL="http://192.168.1.50" \
      -e DEVICE_TIMEZONE_OFFSET="-5" \
      your-username/torus-scraper:v1
    
    ```
3.  **Push to Registry:**
    ``` bash
    docker push your-username/torus-scraper:v1
    
    ```

### 2\. Kubernetes Deployment

Use the provided `cronjob.yaml` to deploy to your cluster.

1.  **Create a Secret** for your password:
    ``` bash
    kubectl create secret generic torus-secrets --from-literal=password='YOUR_REAL_PASSWORD'
    
    ```
2.  **Edit `cronjob.yaml`** to match your environment variables and image name.
3.  **Apply:**
    ``` bash
    kubectl apply -f cronjob.yaml
    
    ```

## Grafana Visualization

Use these PromQL queries to build your dashboard:

  * **Input Voltage:** `torus_input_voltage_volts`
  * **Output Power:** `torus_output_power_watts`
  * **Device Status (Seconds Since Last Update):** `time() - torus_device_last_seen_timestamp`
  * **Data Source (0=Cloud, 1=Local):** `torus_data_source`

## Project Structure

  * `torus-scraper.js`: Main Node.js application logic.
  * `Dockerfile`: Multi-stage build definition using Node 20 Alpine.
  * `package.json`: Dependencies (axios, cheerio, qs).
