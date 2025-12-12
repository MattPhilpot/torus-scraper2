## **Torus Power Hybrid Scraper**

Node.js scraper designed to monitor **Torus Power** units by collecting metrics from both the **Torus Power Connect cloud dashboard** and the device's **local web interface**.

It pushes these metrics to a **Prometheus Pushgateway** for visualization in Grafana.

*Disclaimer: Node.js isn't my specialty, so I was assisted in part by Gemini to get portions of this working*

## **Features**

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

## **Prerequisites**

  * Docker
  * Kubernetes Cluster (optional, for CronJob deployment)
  * Prometheus Pushgateway

## **Configuration**

The scraper is configured entirely via Environment Variables.

| Variable                     | Description                                         | Default | Required?                         |
| :--------------------------: | :-------------------------------------------------: | :-----: | :-------------------------------: |
| **TORUS\_USERNAME**          | Cloud login email/username                          | None    | **Yes**                           |
| **TORUS\_PASSWORD**          | Cloud login password                                | None    | **Yes**                           |
| **PUSHGATEWAY\_URL**         | URL of your Pushgateway                             | None    | **Yes**                           |
| **TORUS\_LOCAL\_URL**        | IP/URL of local device (e.g. <http://192.168.1.50>) | None    | No (but recommended for fallback) |
| **DEVICE\_TIMEZONE\_OFFSET** | Device timezone offset from UTC (e.g. -5 for EST)   | 0       | No                                |
| **JOB\_DURATION**            | How long the script runs before exiting (seconds)   | 280     | No                                |
| **POLL\_INTERVAL**           | How often to fetch data within the loop (seconds)   | 15      | No                                |
| **LOCAL\_SCRAPE\_INTERVAL**  | Min seconds between local scrapes (Rate Limit)      | 300     | No                                |
| **ENABLE\_CLOUD\_BACKOFF**   | Enable/Disable the cloud check back-off strategy    | true    | No                                |

## **Building & Running**

**1. Local Docker Build**

1.  **Build the image:**
    `docker build -t your-username/torus-scraper:v1 .`
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
    `docker push your-username/torus-scraper:v1`

**2. Kubernetes Deployment**

Use the provided `cronjob.yaml` to deploy to your cluster.

1.  **Create a Secret** for your password:
    `kubectl create secret generic torus-secrets --from-literal=password='YOUR_REAL_PASSWORD'`
2.  **Edit `cronjob.yaml`** to match your environment variables and image name.
3.  **Apply:**
    `kubectl apply -f cronjob.yaml`

## **Prometheus Metrics Reference**

Use these metric names when building your Grafana dashboard.

| Metric Name                                 | Type    | Description                                                   |
| :-----------------------------------------: | :-----: | :-----------------------------------------------------------: |
| **torus\_input\_voltage\_volts**            | Gauge   | Input voltage reading from the device.                        |
| **torus\_output\_voltage\_volts**           | Gauge   | Output voltage reading from the device.                       |
| **torus\_output\_current\_amps**            | Gauge   | Current load in Amps.                                         |
| **torus\_output\_power\_watts**             | Gauge   | Power consumption in Watts.                                   |
| **torus\_output\_thd\_percent**             | Gauge   | Total Harmonic Distortion (Cloud only).                       |
| **torus\_device\_last\_seen\_timestamp**    | Counter | Unix timestamp of when the device last reported to the cloud. |
| **torus\_scrape\_last\_success\_timestamp** | Counter | Unix timestamp of when the scraper last ran successfully.     |
| **torus\_data\_source**                     | Enum    | Indicates the origin of the data point (See below).           |

## **Data Source Values (`torus_data_source`)**

This metric is crucial for understanding data freshness and accuracy.

| Value | Name              | Description                                                           |
| :---: | :---------------: | :-------------------------------------------------------------------: |
| **0** | **CLOUD**         | Fresh, high-precision data from Torus Power Cloud.                    |
| **1** | **LOCAL\_FRESH**  | Cloud stale; data successfully scraped from local device IP just now. |
| **2** | **CLOUD\_STALE**  | Cloud stale AND local fallback failed/unavailable. Data is old.       |
| **3** | **LOCAL\_CACHED** | Cloud stale; reusing cached local data (due to 5min rate limit).      |

**Grafana Visualization Tips**

  * **Device Status:** Use `time() - torus_device_last_seen_timestamp` to show "Seconds Since Update".
      * Green: \< 60s
      * Red: \> 3600s
  * **Data Source:** Use a "Stat" or "State Timeline" panel mapped to the values above (0=Green/Cloud, 1=Blue/Local).

**Project Structure**

  * `torus-scraper.js`: Main Node.js application logic.
  * `Dockerfile`: Multi-stage build definition using Node 20 Alpine.
  * `package.json`: Dependencies (axios, cheerio, qs).
  * `cronjob.yaml`: Kubernetes deployment manifest.
