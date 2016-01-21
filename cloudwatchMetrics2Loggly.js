// JavaScript source code
var AWS = require('aws-sdk')
  , Q = require('q')
  , request = require('request');

//AWS keys configuration
//user need to edit while uploading code via blueprint
var awsConfiguration = {
  accessKeyId: 'xxxx',
  secretAccessKey: 'xxxxx',
  region: 'xxxx',

};

//loggly url, token and tag configuration
//user need to edit while uploading code via blueprint
var logglyConfiguration = {
  url: 'http://logs-01.loggly.com/bulk',
  customerToken: 'your-customer-token',
  tags: 'CloudwatchMetrics'
};

AWS.config.update({
  accessKeyId: awsConfiguration.accessKeyId,
  secretAccessKey: awsConfiguration.secretAccessKey,
  region: awsConfiguration.region
});

var cloudwatch = new AWS.CloudWatch({
  apiVersion: '2010-08-01'
});

//entry point
exports.handler = function (event, context) {
  var finalData = [];
  var parsedStatics = [];

  var nowDate = new Date();
  var date = nowDate.getTime();

  //time upto which we want to fetch Metrics Statics
  //we keep it one hour
  var logEndTime = nowDate.toISOString();

  //time from which we want to fetch Metrics Statics
  var logStartTime = new Date(date - (05 * 60 * 1000)).toISOString();

  //setup keys in the aws object
  AWS.config.update({
    accessKeyId: awsConfiguration.accessKeyId,
    secretAccessKey: awsConfiguration.secretAccessKey,
    region: awsConfiguration.region
  });

  //initiate the script here
  getMetricsListFromAWSCloudwatch().then(function () {
    sendRemainingStatics().then(function () {
      console.log('all statics are sent to Loggly');
      context.done();
    }, function () {
      console.log("Error");
      context.done();
    });
  }, function () { });


  //retreives all list of valid metrics from cloudwatch
  function getMetricsListFromAWSCloudwatch() {

    return Q.Promise(function (resolve, reject) {
      var promisesResult = [];
      var getMetricsList = function (nextToken) {
        // Remove Coments if requierd filter
        var params = {
          
          /*
          // Add filter dimensions
          // Remove Coments if requierd filter
          Dimensions: [{
              // Required
              Name:"String_Value" ,
              Value:"" 
            },
          ],
          //Add Metric name : ["CPUUtilization","DiskReadOps","StatusCheckFailed_System"] -> String Values
          MetricName:"String Value"           
          // more filters
            
         */
        };


        //The token returned by a previous call to indicate that there is more data available
        //if nextToken returned then next token should
        //present to get the Metrics from next page
        if (nextToken != null) {
          params.NextToken = nextToken;
        }

        cloudwatch.listMetrics(params, function (err, result) {
          if (err) {
            console.log(err, err.stack); // an error occurred
          }
          else {
            var pMetricName, pNamespace, pName, pValue;

            for (var i = 0; i < result.Metrics.length; i++) {
              pNamespace = result.Metrics[i].Namespace;
              pMetricName = result.Metrics[i].MetricName;
              for (var j = 0; j < result.Metrics[i].Dimensions.length; j++) {
                pName = result.Metrics[i].Dimensions[j].Name
                pValue = result.Metrics[i].Dimensions[j].Value
              }
              var promise = fetchMetricStatisticsFromMetrics(pNamespace, pMetricName, pName, pValue);
              promisesResult.push(promise)
            }
          }
          if (result.NextToken) {

            getMetricsList(result.NextToken);
          }
          else {
            Q.allSettled(promisesResult)
           .then(function () {
             resolve();
           }, function () {
             reject();
           });
          }
        });
      }
      getMetricsList();
    });
  }

  //Gets statistics for the specified metric.
  function fetchMetricStatisticsFromMetrics(namespace, metricName, dName, dValue) {
    var MetricStatisticsPromises = [];
    return Q.Promise(function (resolve, reject) {

      /*The maximum number of data points returned from a single GetMetricStatistics request is 1,440, 
      wereas the maximum number of data points that can be queried is 50,850. If you make a request 
      that generates more than 1,440 data points, Amazon CloudWatch returns an error. In such a case, 
      you can alter the request by narrowing the specified time range or increasing the specified period. 
      Alternatively, you can make multiple requests across adjacent time ranges.*/

      var params = {
        EndTime: logEndTime, //required
        MetricName: metricName, //required
        Namespace: namespace, //required
        Period: 60, //required
        StartTime: logStartTime, //required
        Statistics: [ //required
             'Average', 'Minimum', 'Maximum', 'SampleCount', 'Sum'
        ],
        Dimensions: [{
          Name: dName,  // required
          Value: dValue //required
        },
            /* more items */
        ],

      };
      var Promises = [];
      try {
        cloudwatch.getMetricStatistics(params, function (err, data) {
          if (err) console.log(err, err.stack); // an error occurred
          else {
            for (var a in data.Datapoints) {
              var promise = parseStatics(data.Datapoints[a], data.ResponseMetadata, data.Label, dName, dValue, namespace)
              Promises.push(promise);
            }
            Q.allSettled(Promises).then(function () {
              resolve();
            }, function () {
              reject();
            });
          }
        });
      }
      catch (e) {
        console.log(e);
      }
    });
  }

  //converts the Statics to a valid JSON object with the sufficient infomation required

  function parseStatics(metricsStatics, responseMetadata, metricName, dimensionName, dimensionValue, namespace) {
    return Q.promise(function (resolve, reject) {

      var staticdata = {
        "timestamp": metricsStatics.Timestamp.toISOString(),
        "sampleCount": metricsStatics.SampleCount,
        "average": metricsStatics.Average,
        "sum": metricsStatics.Sum,
        "minimum": metricsStatics.Minimum,
        "maximum": metricsStatics.Maximum,
        "unit": metricsStatics.Unit,
        "metricName": metricName,
        "namespace": namespace
      };
      staticdata[firstToLowerCase(dimensionName)] = dimensionValue;

      postStaticsToLoggly(staticdata).then(function () {
        resolve();
      }, function () {
        reject();
      });

    });
  }

  //uploads the statics to Loggly
  //we will hold the statics in an array until they reaches to 200
  //then set the count of zero.
  function postStaticsToLoggly(event) {

    return Q.promise(function (resolve, reject) {
      if (parsedStatics.length == 200) {
        upload().then(function () {
          resolve();
        }, function () {
          reject();
        });
      } else {
        parsedStatics.push(event);
        resolve();
      }
    });
  }

  //checks if any more statics are left
  //after sending Statics in multiples of 100
  function sendRemainingStatics() {
    return Q.promise(function (resolve, reject) {
      if (parsedStatics.length > 0) {
        upload().then(function () {
          resolve();
        }, function () {
          reject();
        });
      } else {
        resolve();
      }
    });
  }

  function upload() {
    return Q.promise(function (resolve, reject) {

      //get all the Statics, stringify them and join them
      //with the new line character which can be sent to Loggly
      //via bulk endpoint
      var finalResult = parsedStatics.map(JSON.stringify).join('\n');

      //empty the main statics array immediately to hold new statics
      parsedStatics.length = 0;

      //creating logglyURL at runtime, so that user can change the tag or customer token in the go
      //by modifying the current script
      var logglyURL = logglyConfiguration.url + '/' + logglyConfiguration.customerToken + '/tag/' + logglyConfiguration.tags;

      //create request options to send Statics
      try {
        var requestOptions = {
          uri: logglyURL,
          method: 'POST',
          headers: {}
        };

        requestOptions.body = finalResult;

        //now send the Statics to Loggly
        request(requestOptions, function (err, response, body) {
          if (err) {
            console.log('Error while uploading Statics to Loggly');
            reject();
          } else {
            resolve();
          }
        });
        
      } catch (ex) {
        console.log(ex.message);
        reject();
      }
    });
  }

  //function to convert the first letter of the string to lowercase
  function firstToLowerCase(str) {
    return str.substr(0, 1).toLowerCase() + str.substr(1);
  }
}
